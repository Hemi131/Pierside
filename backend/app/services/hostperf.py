"""Server performance of the active SSH engine's server ("Server performance", like htop).

Everything is read from /proc, so nothing has to be installed on the server and it works with GNU and
BusyBox tools alike. One sample = one shell script that reads the whole-server figures and every
process's stat / cgroup / io / command line in bulk (grep and head over all files at once, not a process
per process). Rates (CPU %, disk and network per second) come from the difference to the previous
sample; HISTORY_S of samples are kept for the page's charts while the page is open.

The output mixes our own section markers with text that any user on the server controls (process names
and command lines). So the markers carry a random token per sample (`$M`), which reaches the script
through stdin (SSH) or the environment (helper), never its command line, where other users could read
it; and the parsing never lets process text decide the structure: a name spanning lines is joined, a
process whose stat line isn't unambiguous is left out, and a command line whose header appears twice is
treated as unknown rather than believed.

Per process: CPU and memory are readable for every process as the SSH user; disk I/O (/proc/<pid>/io)
only for the user's own. Where the user allowed Docker for this server (the same answer as for Server
files, hostfs.consent) and Docker can help there (hostfs.docker_problem), the process part runs as root
in a helper container that shares the server's process namespace (PidMode host, no network, no mounts,
with SYS_PTRACE to read other users' I/O figures and SYS_NICE to change their priority), so disk I/O and
the actions work for every process.

Each process is tied to its container through the container id in its cgroup.

Actions (end, force end, lower priority) name the engine they were meant for and check the process's
start time first, so a process id reused by another process, or another server after a switch, is never
hit; process 1, 2 and kernel threads are refused.
"""

import asyncio
import logging
import re
import secrets
import time

import aiodocker

from app.services import hostfs
from app.services.docker_client import get_docker, query_json
from app.services.fsbrowse import FsError
from app.services.helper import HELPER_IMAGE, HELPER_LABEL, _ensure_image

log = logging.getLogger("pierside.hostperf")

MIN_INTERVAL_S = 1.5  # samples asked for more often than this are served from the last one
HISTORY_S = 600
VIEW_TTL_S = 20  # helper kept this long after the page stopped asking
HELPER_TIMEOUT_S = 20  # a helper command (reading /proc can block on a process) is given up after this
MAX_PROCESSES = 1500  # sent to the page: the busiest (CPU, then memory); the count says how many there are
_CONTAINER_ID = re.compile(r"[0-9a-f]{64}")

# Section markers are "$M:<name>", $M = "@@" + a random token (see the module docstring). `timeout`
# (where it exists) stops a read of /proc that blocks on a process.
#
# Markers are printed on a line of their own (printf '\n…\n'): a read cut off by `timeout` mid-line
# can't glue them to its last line. `timeout` takes "8 PROG" in GNU and newer BusyBox, "-t 8 PROG" in
# BusyBox before 1.30: the form that works is tried, none is used if neither does.
SYSTEM_SCRIPT = r"""
mark() { printf '\n%s\n' "$M:$1"; }
mark stat; cat /proc/stat
mark mem; cat /proc/meminfo
mark load; cat /proc/loadavg; cat /proc/uptime
mark vm; grep -E '^(pswpin|pswpout) ' /proc/vmstat
mark psi; for r in cpu memory io; do [ -r /proc/pressure/$r ] && sed "s/^/$r /" /proc/pressure/$r; done
mark disk; cat /proc/diskstats
mark net; cat /proc/1/net/dev 2>/dev/null || cat /proc/net/dev
mark tck; getconf CLK_TCK 2>/dev/null || echo 100; getconf PAGESIZE 2>/dev/null || echo 4096
"""
PROCESS_SCRIPT = r"""
mark() { printf '\n%s\n' "$M:$1"; }
to=; if timeout 8 true 2>/dev/null; then to="timeout 8"; elif timeout -t 8 true 2>/dev/null; then to="timeout -t 8"; fi
mark puptime; cat /proc/uptime
mark pstat; $to grep -s -H '' /proc/[0-9]*/stat
mark pstatus; $to grep -s -H '^Uid:' /proc/[0-9]*/status
mark pcg; $to grep -s -H -m1 -oE '[0-9a-f]{64}' /proc/[0-9]*/cgroup
mark pio; $to grep -s -H -E '^(read_bytes|write_bytes):' /proc/[0-9]*/io
mark pcmd; $to head -c 400 /proc/[0-9]*/cmdline 2>/dev/null; s=$?
mark pcmdend; echo "$s"
"""


def new_marker() -> str:
    return "@@" + secrets.token_hex(12)


def with_marker(marker: str, script: str) -> str:
    """A script for stdin (`sh -s`): the marker is set in it, so it never shows in a command line."""
    return f"M={marker}\n{script}"


# ---- parsing -------------------------------------------------------------------------------------------


def _sections(text: str, marker: str) -> dict[str, str]:
    """Sections start at lines that are exactly '<marker>:<name>' (nothing else can produce one)."""
    out: dict[str, str] = {}
    name = ""
    buf: list[str] = []
    head = marker + ":"
    for line in text.split("\n"):
        if line.startswith(head) and line[len(head) :].isalnum():
            if name:
                out[name] = "\n".join(buf)
            name, buf = line[len(head) :], []
        else:
            buf.append(line)
    if name:
        out[name] = "\n".join(buf)
    return out


def _pid_lines(text: str, suffix: str) -> dict[int, list[str]]:
    """'/proc/<pid>/<suffix>:<value>' entries grouped by pid. A line that doesn't start such an entry
    continues the one before (a process name may contain a line break)."""
    out: dict[int, list[str]] = {}
    last: list[str] | None = None
    for line in text.split("\n"):
        path, sep, value = line.partition(":")
        parts = path.split("/") if sep else []
        if len(parts) == 4 and parts[0] == "" and parts[1] == "proc" and parts[3] == suffix and parts[2].isdigit():
            last = out.setdefault(int(parts[2]), [])
            last.append(value)
        elif last is not None and line:
            last[-1] += "\n" + line
    return out


def _parse_stat(value: str) -> dict | None:
    open_, close = value.find("("), value.rfind(")")
    if open_ < 0 or close < open_:
        return None
    f = value[close + 2 :].split()
    if len(f) < 22 or not all(x.lstrip("-").isdigit() for x in (f[1], f[11], f[12], f[16], f[17], f[19], f[21])):
        return None
    return {
        "name": value[open_ + 1 : close].replace("\n", " "),
        "state": f[0],
        "ppid": int(f[1]),
        "ticks": int(f[11]) + int(f[12]),
        "nice": int(f[16]),
        "threads": int(f[17]),
        "start": int(f[19]),
        "rssPages": int(f[21]),
    }


def parse_system(sec: dict[str, str]) -> dict:
    cpus: dict[str, list[int]] = {}
    for line in sec.get("stat", "").split("\n"):
        f = line.split()
        if f and f[0].startswith("cpu"):
            cpus[f[0]] = [int(x) for x in f[1:9]] + [0] * max(0, 8 - len(f[1:9]))
    mem = {}
    for line in sec.get("mem", "").split("\n"):
        k, _, v = line.partition(":")
        if v.strip():
            mem[k.strip()] = int(v.split()[0]) * 1024
    if "MemAvailable" not in mem and "MemFree" in mem:  # kernels before 3.14: an estimate like free(1)'s
        mem["MemAvailable"] = mem["MemFree"] + mem.get("Buffers", 0) + mem.get("Cached", 0)
    load_lines = sec.get("load", "").strip().split("\n")
    load = [float(x) for x in load_lines[0].split()[:3]] if load_lines and load_lines[0] else [0.0, 0.0, 0.0]
    uptime = float(load_lines[1].split()[0]) if len(load_lines) > 1 and load_lines[1] else 0.0
    vm = {}
    for line in sec.get("vm", "").split("\n"):
        f = line.split()
        if len(f) == 2:
            vm[f[0]] = int(f[1])
    psi = {}
    for line in sec.get("psi", "").split("\n"):
        f = line.split()
        if len(f) >= 3 and f[1] == "some":
            psi[f[0]] = float(f[2].split("=")[1])
    disks = {}
    for line in sec.get("disk", "").split("\n"):
        f = line.split()
        if len(f) >= 14 and _whole_disk(f[2]):
            disks[f[2]] = (int(f[5]), int(f[9]), int(f[12]))  # sectors read, sectors written, ms doing I/O
    net = {}
    for line in sec.get("net", "").split("\n"):
        if ":" not in line:
            continue
        name, _, rest = line.partition(":")
        name, f = name.strip(), rest.split()
        if len(f) >= 9 and _real_interface(name):
            net[name] = (int(f[0]), int(f[8]))
    tck = sec.get("tck", "").split()
    return {
        "cpus": cpus,
        "mem": mem,
        "load": load,
        "uptime": uptime,
        "vm": vm,
        "psi": psi,
        "disks": disks,
        "net": net,
        "tck": int(tck[0]) if tck and tck[0].isdigit() else 100,
        "page": int(tck[1]) if len(tck) > 1 and tck[1].isdigit() else 4096,
    }


_PARTITION = re.compile(r"^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)\d+$|^(nvme\d+n\d+|mmcblk\d+)p\d+$")


def _whole_disk(name: str) -> bool:
    return not (name.startswith(("loop", "ram", "zram", "sr", "fd")) or _PARTITION.match(name))


def _virtual_disk(name: str) -> bool:
    """LVM, dm-crypt, RAID: built on the disks listed too, so left out of the totals (counted twice otherwise)."""
    return name.startswith(("dm-", "md"))


def _real_interface(name: str) -> bool:
    return name != "lo" and not name.startswith(("veth", "br-", "docker", "cni", "flannel", "cali", "vxlan", "virbr", "tunl", "kube"))


def parse_processes(sec: dict[str, str]) -> tuple[dict[int, dict], int]:
    """The processes, and how many couldn't be read unambiguously (left out, but counted for the page)."""
    procs: dict[int, dict] = {}
    unreadable = 0
    for pid, values in _pid_lines(sec.get("pstat", ""), "stat").items():
        parsed = [p for p in (_parse_stat(v) for v in values) if p]
        if len(parsed) == 1:  # more than one reading (or none) for a pid: not to be trusted, left out
            procs[pid] = {"pid": pid, **parsed[0]}
        else:
            unreadable += 1
    for pid, values in _pid_lines(sec.get("pstatus", ""), "status").items():
        if pid in procs and len(values) == 1:
            uid = values[0].replace("Uid:", "").split()
            procs[pid]["uid"] = int(uid[0]) if uid and uid[0].isdigit() else None
    for pid, values in _pid_lines(sec.get("pcg", ""), "cgroup").items():
        if pid in procs and _CONTAINER_ID.fullmatch(values[0].strip()):
            procs[pid]["cid"] = values[0].strip()
    for pid, values in _pid_lines(sec.get("pio", ""), "io").items():
        if pid in procs:
            io = {k.strip(): int(v) for k, _, v in (l.partition(":") for l in values) if v.strip().isdigit()}
            procs[pid]["io"] = (io.get("read_bytes", 0), io.get("write_bytes", 0))
    # Command lines: head prints "==> /proc/<pid>/cmdline <==" before each file. A command line can contain
    # such a line itself: a header seen twice for a pid means its command line can't be told, so none.
    # And if head was stopped part-way (timeout: 124 in GNU, a signal from 128 up in BusyBox), the later
    # pids have no real header for a process before them to be checked against: then none are used.
    # (Status 1 only means a process ended between listing and reading.)
    status = sec.get("pcmdend", "").strip()
    if not status.isdigit() or int(status) == 124 or int(status) >= 128:
        return procs, unreadable
    cmds = sec.get("pcmd", "")
    headers = list(re.finditer(r"(?:^|\n)==> /proc/(\d+)/cmdline <==\n", cmds))
    seen: dict[int, int] = {}
    for h in headers:
        seen[int(h.group(1))] = seen.get(int(h.group(1)), 0) + 1
    for i, h in enumerate(headers):
        pid = int(h.group(1))
        if pid not in procs or seen[pid] > 1:
            continue
        end = headers[i + 1].start() if i + 1 < len(headers) else len(cmds)
        procs[pid]["cmd"] = cmds[h.end() : end].replace("\x00", " ").replace("\n", " ").strip()
    return procs, unreadable


# ---- sampling ------------------------------------------------------------------------------------------


class _State:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()  # one sample at a time
        self.helper_lock = asyncio.Lock()  # creating / removing the helper
        self.helper: str | None = None
        self.viewed = 0.0
        self.reset(None)

    def reset(self, engine: str | None) -> None:
        """Another server: forget its figures (the locks and the helper bookkeeping stay)."""
        self.engine = engine
        self.prev: tuple[float, float, dict, dict] | None = None  # (system time, process time, system, processes)
        self.history: list[dict] = []
        self.last: dict | None = None
        self.last_at = 0.0
        self.users: dict[int, str] = {}


_s = _State()
_reaper: asyncio.Task | None = None


async def _ssh(script: str, marker: str | None = None) -> str:
    """Run a script over SSH, given on stdin (`sh -s`) so that its marker isn't in any command line."""
    code, out, err = await hostfs.ssh_run(["sh", "-s"], (with_marker(marker, script) if marker else script).encode())
    if code not in (0, 1) and not out:  # grep without a match exits 1
        raise FsError(err.decode("utf-8", "replace").strip() or f"reading the server's figures failed ({code})", 502)
    return out.decode("utf-8", "replace")


async def _root_mode() -> bool:
    """Read and act as root: the user allowed Docker for this server, and Docker can help there."""
    return hostfs.consent() is True and await hostfs.docker_problem() is None


async def _helper() -> str:
    """A helper container in the server's process namespace (root, no network, no mounts), kept while the
    page is open. SYS_PTRACE lets it read other users' /proc/<pid>/io, SYS_NICE change their priority."""
    async with _s.helper_lock:
        if _s.helper:
            try:
                if ((await query_json(f"containers/{_s.helper}/json")).get("State") or {}).get("Running"):
                    return _s.helper
            except aiodocker.DockerError:
                pass
            _s.helper = None
        await _ensure_image()
        c = await get_docker().containers.create(
            {
                "Image": HELPER_IMAGE,
                "Cmd": ["sleep", "3600"],
                "Labels": {HELPER_LABEL: "true", f"{HELPER_LABEL}.perf": "true"},
                "NetworkDisabled": True,
                "HostConfig": {"PidMode": "host", "AutoRemove": True, "NetworkMode": "none", "CapAdd": ["SYS_PTRACE", "SYS_NICE"]},
            }
        )
        await c.start()
        _s.helper = c.id
        _start_reaper()
        return c.id


async def _in_helper(cmd: list[str], env: dict[str, str] | None = None) -> tuple[int, bytes, bytes]:
    """Run a command in the helper, with a time limit (a read of /proc can block on a process)."""

    async def run() -> tuple[int, bytes, bytes]:
        exe = await get_docker().containers.container(await _helper()).exec(cmd, stdout=True, stderr=True, stdin=False, tty=False, environment=env)
        out, err = b"", b""
        async with exe.start(detach=False) as stream:
            while True:
                msg = await stream.read_out()
                if msg is None:
                    break
                if msg.stream == 2:
                    err += msg.data
                else:
                    out += msg.data
        return (await exe.inspect()).get("ExitCode") or 0, out, err

    try:
        return await asyncio.wait_for(run(), HELPER_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise FsError(f"The server didn't answer within {HELPER_TIMEOUT_S} seconds", 504)


def _start_reaper() -> None:
    global _reaper
    if _reaper is None or _reaper.done():
        _reaper = asyncio.create_task(_reap(), name="hostperf-reaper")


async def _reap() -> None:
    while _s.helper:
        await asyncio.sleep(10)
        if time.monotonic() - _s.viewed > VIEW_TTL_S:
            await release()


async def release() -> None:
    """Remove the helper (engine switched, page left a while ago). Waits for a sample in flight, so that
    one can't (re)create a helper on the engine being left after it was removed."""
    async with _s.lock:
        await _release()


async def release_for_switch() -> None:
    """Before an engine switch: like release(), but a sample stuck on a hanging server (up to the SSH
    time limit) doesn't hold up the switch for long. Then the helper is removed without waiting, while
    the client still points at its engine (later, the reaper would look on the new one)."""
    try:
        await asyncio.wait_for(release(), 5)
    except asyncio.TimeoutError:
        await _release()


async def leave() -> None:
    """The page was left: remove the helper soon, unless the page is read again meanwhile (left and come
    back quickly: its read mustn't lose the helper under it)."""
    left = time.monotonic()
    await asyncio.sleep(3)
    if _s.viewed <= left:
        await release()


async def _release() -> None:
    """Remove the helper (call with _s.lock held, or from the sample itself)."""
    async with _s.helper_lock:
        cid, _s.helper = _s.helper, None
    if cid:
        try:
            await get_docker().containers.container(cid).delete(force=True)
        except Exception:
            pass


async def _users() -> dict[int, str]:
    if not _s.users:
        try:
            for line in (await _ssh("cat /etc/passwd")).split("\n"):
                f = line.split(":")
                if len(f) > 2 and f[2].isdigit():
                    _s.users[int(f[2])] = f[0]
        except FsError:
            pass
    return _s.users


async def _containers() -> dict[str, dict]:
    try:
        rows = await query_json("containers/json", params={"all": "1"})
    except Exception:
        return {}
    out = {}
    for c in rows:
        labels = c.get("Labels") or {}
        out[c["Id"]] = {
            "id": c["Id"][:12],
            "name": (c.get("Names") or ["/"])[0].lstrip("/"),
            "project": labels.get("com.docker.compose.project"),
            "service": labels.get("com.docker.compose.service"),
        }
    return out


async def sample() -> dict:
    """The current figures (a new sample at most every MIN_INTERVAL_S), with rates and history."""
    eid = hostfs.engine_id()
    _s.viewed = time.monotonic()
    async with _s.lock:
        if _s.engine != eid:  # another server: start over
            await _release()
            _s.reset(eid)
        root = await _root_mode()
        # The last sample serves only if read the same way (the Docker switch may have just changed).
        if _s.last and time.monotonic() - _s.last_at < MIN_INTERVAL_S and (_s.last["via"] == "docker") == root:
            return _s.last
        if not root and _s.helper:
            await _release()  # Docker was switched off for this server: no root helper any more
        marker = new_marker()
        if root:
            # The whole-server part over SSH (the same figures), the processes as root in the helper.
            async def processes() -> str:
                code, out, err = await _in_helper(["sh", "-c", PROCESS_SCRIPT], {"M": marker})
                if code not in (0, 1) and not out:
                    raise FsError(err.decode("utf-8", "replace").strip() or f"reading the processes failed ({code})", 502)
                return out.decode("utf-8", "replace")

            system_text, process_text = await asyncio.gather(_ssh(SYSTEM_SCRIPT, marker), processes())
        else:
            system_text = process_text = await _ssh(SYSTEM_SCRIPT + PROCESS_SCRIPT, marker)
        # Thousands of processes are megabytes of text: parsed off the event loop.
        system = parse_system(_sections(system_text, marker))
        process_sec = _sections(process_text, marker)
        procs, unreadable = await asyncio.to_thread(parse_processes, process_sec)
        ptime = parse_system({"load": "0 0 0\n" + process_sec.get("puptime", "").strip()})["uptime"]
        users, containers = await asyncio.gather(_users(), _containers())
        result = {**_build(system, ptime, procs, users, containers, root), "unreadable": unreadable}
        _s.last, _s.last_at = result, time.monotonic()
        return result


def _build(system: dict, ptime: float, procs: dict[int, dict], users: dict[int, str], containers: dict[str, dict], root: bool) -> dict:
    now = system["uptime"] or time.monotonic()
    ptime = ptime or now
    prev = _s.prev
    _s.prev = (now, ptime, system, procs)
    dt = (now - prev[0]) if prev and now > prev[0] else 0.0
    pdt = (ptime - prev[1]) if prev and ptime > prev[1] else 0.0  # the processes' own interval
    tck, page = system["tck"], system["page"]
    ncpu = max(1, len([k for k in system["cpus"] if k != "cpu"]))
    mem = system["mem"]
    total = mem.get("MemTotal", 0)
    available = mem.get("MemAvailable", mem.get("MemFree", 0))

    def cpu_split(name: str) -> dict | None:
        if not prev or name not in system["cpus"] or name not in prev[2]["cpus"]:
            return None
        a, b = prev[2]["cpus"][name], system["cpus"][name]
        d = [y - x for x, y in zip(a, b)]
        all_ = sum(d) or 1
        # user nice system idle iowait irq softirq steal
        return {
            "user": round((d[0] + d[1]) * 100 / all_, 1),
            "system": round((d[2] + d[5] + d[6]) * 100 / all_, 1),
            "iowait": round(d[4] * 100 / all_, 1),
            "steal": round(d[7] * 100 / all_, 1),
            "busy": round((all_ - d[3] - d[4]) * 100 / all_, 1),
        }

    cpu = cpu_split("cpu")
    cores = [cpu_split(f"cpu{i}") for i in range(ncpu)]
    disks, net = [], []
    if prev and dt > 0:
        for name, (r, w, busy) in system["disks"].items():
            if name in prev[2]["disks"]:
                pr, pw, pb = prev[2]["disks"][name]
                disks.append(
                    {
                        "name": name,
                        "read": max(0, r - pr) * 512 / dt,
                        "write": max(0, w - pw) * 512 / dt,
                        "util": min(100.0, round(max(0, busy - pb) / (dt * 10), 1)),
                        "virtual": _virtual_disk(name),
                    }
                )
        for name, (rx, tx) in system["net"].items():
            if name in prev[2]["net"]:
                prx, ptx = prev[2]["net"][name]
                net.append({"name": name, "rx": max(0, rx - prx) / dt, "tx": max(0, tx - ptx) / dt})
    swap_rate = 0.0
    if prev and dt > 0:
        swap_rate = sum(max(0, system["vm"].get(k, 0) - prev[2]["vm"].get(k, 0)) for k in ("pswpin", "pswpout")) * page / dt

    rows = []
    io_seen = False
    for pid, p in procs.items():
        kernel = pid == 2 or p["ppid"] == 2
        before = prev[3].get(pid) if prev else None
        same = before is not None and before["start"] == p["start"]
        cpu_pct = round((p["ticks"] - before["ticks"]) * 100 / (pdt * tck), 1) if same and pdt > 0 else 0.0
        read = write = None
        if "io" in p:
            io_seen = True
            if same and "io" in before and pdt > 0:
                read = max(0, p["io"][0] - before["io"][0]) / pdt
                write = max(0, p["io"][1] - before["io"][1]) / pdt
        c = containers.get(p.get("cid", ""))
        uid = p.get("uid")
        rows.append(
            {
                "pid": pid,
                "ppid": p["ppid"],
                "start": p["start"],
                "name": p["name"],
                "cmd": p.get("cmd") or f"[{p['name']}]",
                "user": users.get(uid, str(uid)) if uid is not None else "?",
                "state": p["state"],
                "nice": p["nice"],
                "threads": p["threads"],
                "cpu": max(0.0, cpu_pct),
                "mem": p["rssPages"] * page,
                "read": read,
                "write": write,
                "kernel": kernel,
                "container": c,
                "seconds": round(ptime - p["start"] / tck) if ptime else None,
            }
        )
    total_processes = len(rows)
    if len(rows) > MAX_PROCESSES:
        rows = sorted(rows, key=lambda r: (-r["cpu"], -r["mem"]))[:MAX_PROCESSES]
    physical = [d for d in disks if not d["virtual"]]
    point = {
        "t": time.time(),
        "cpu": cpu["busy"] if cpu else None,
        "mem": total - available,
        "read": sum(d["read"] for d in physical),
        "write": sum(d["write"] for d in physical),
        "rx": sum(n["rx"] for n in net),
        "tx": sum(n["tx"] for n in net),
    }
    if prev:
        _s.history.append(point)
        cut = time.time() - HISTORY_S
        _s.history = [h for h in _s.history if h["t"] >= cut]
    summary = {
        "cpus": ncpu,
        "uptime": now,
        "cpu": cpu,
        "cores": cores,
        "load": system["load"],
        "mem": {
            "total": total,
            "used": total - available,
            "available": available,
            "cached": mem.get("Cached", 0) + mem.get("Buffers", 0) + mem.get("SReclaimable", 0),
            "swapTotal": mem.get("SwapTotal", 0),
            "swapUsed": mem.get("SwapTotal", 0) - mem.get("SwapFree", 0),
            "swapRate": swap_rate,
        },
        "psi": system["psi"],
        "disks": sorted(disks, key=lambda d: -(d["read"] + d["write"])),
        "net": sorted(net, key=lambda n: -(n["rx"] + n["tx"])),
        "processes": total_processes,
    }
    return {
        "engine": _s.engine,
        "via": "docker" if root else "ssh",
        "user": hostfs.ssh_user(),
        "ioAll": root,  # disk I/O for every process (root), or only the SSH user's own
        "ioSeen": io_seen,
        "warming": prev is None,  # the first sample has no rates yet
        "summary": summary,
        "hints": hints(summary),
        "history": _s.history,
        "processes": rows,
        "processesShown": len(rows),
    }


def hints(s: dict) -> list[dict]:
    """Plain-language notes on what stands out right now (the page's "why is it slow" line)."""
    out = []
    mem, cpu = s["mem"], s["cpu"] or {}
    if mem["total"] and mem["available"] / mem["total"] < 0.1:
        out.append({"severity": "error", "text": f"Memory is almost full: {mem['available'] * 100 // mem['total']} % available."})
    if mem["swapRate"] > 1024 * 1024:
        out.append({"severity": "warning", "text": "The server is swapping: memory is short, and processes are slowed down by the disk."})
    if cpu.get("iowait", 0) >= 20:
        out.append({"severity": "warning", "text": f"The CPU spends {cpu['iowait']} % of its time waiting for the disk: the disk is the bottleneck."})
    if cpu.get("steal", 0) >= 10:
        out.append({"severity": "warning", "text": f"{cpu['steal']} % of the CPU time is taken by the virtual machine's host (steal): the host is overloaded."})
    if s["load"] and s["load"][1] > s["cpus"] * 1.5:
        out.append({"severity": "warning", "text": f"High load: {s['load'][1]} over the last 5 minutes on {s['cpus']} CPUs, so processes are waiting for their turn."})
    if s["psi"].get("memory", 0) >= 10:
        out.append({"severity": "warning", "text": f"Processes spent {s['psi']['memory']} % of the last 10 seconds waiting for memory."})
    return out


# ---- actions -------------------------------------------------------------------------------------------

# Acts on <pid> only if it still is the process that was seen: same start time (the 20th field after the
# name in /proc/<pid>/stat; the name may hold a line break, hence tr), not a kernel thread (parent 2).
# "lower" sets nice 10 on every thread, and never raises a priority (nice 10 or more already: refused).
_ACT = r"""
pid=$1; start=$2; op=$3
[ -r /proc/$pid/stat ] || { echo "The process has ended." >&2; exit 4; }
set -- $(tr '\n' ' ' < /proc/$pid/stat | sed 's/.*) //')
[ "$2" = 2 ] && { echo "That is a kernel thread." >&2; exit 5; }
[ "${20}" = "$start" ] || { echo "The process has ended (its number is used by another one now)." >&2; exit 4; }
if [ "$op" = lower ]; then
  [ "${17}" -ge 10 ] && { echo "Its priority is low already (nice ${17})." >&2; exit 6; }
  for t in /proc/$pid/task/*; do
    n=$(tr '\n' ' ' < "$t/stat" 2>/dev/null | sed 's/.*) //' | cut -d' ' -f17)
    [ -n "$n" ] || continue                  # the thread ended meanwhile
    [ "$n" -ge 10 ] && continue              # low already: never raised
    renice 10 -p "${t##*/}" >/dev/null || { [ -d "$t" ] && exit 1; }
  done
  exit 0   # the last thread ending meanwhile is no failure
else
  kill -s "$op" "$pid"
fi
"""


async def act(engine: str, pid: int, start: int, action: str) -> dict:
    """End (TERM), force end (KILL) or lower the priority (nice 10) of one process on `engine`."""
    if engine != hostfs.engine_id():
        raise FsError("Another server is active now; nothing was done. Look at the list again.", 409)
    if pid <= 2:
        raise FsError("Pierside doesn't act on the server's first processes (init, kernel threads).", 403)
    signal = {"end": "TERM", "kill": "KILL"}.get(action)
    if signal is None and action != "lower":
        raise FsError("Unknown action", 400)
    args = [str(int(pid)), str(int(start)), signal or "lower"]
    code, _out, err = await hostfs.ssh_run(["sh", "-c", _ACT, "sh", *args])
    text = err.decode("utf-8", "replace").strip()
    via = "ssh"
    denied = lambda t: "not permitted" in t.lower() or "permission denied" in t.lower()  # noqa: E731
    root = await _root_mode()
    if code != 0 and denied(text) and root:
        code, _out, err2 = await _in_helper(["sh", "-c", _ACT, "sh", *args])
        text, via = err2.decode("utf-8", "replace").strip(), "docker"
    if code != 0:
        if denied(text):
            raise FsError(
                f"Your SSH user ({hostfs.ssh_user()}) may not do that to this process."
                + ("" if root else " Switching on \"Use Docker where I have no permission\" lets Pierside do it as root."),
                403,
            )
        raise FsError(text or f"Failed ({code})", 409 if code in (4, 5, 6) else 502)
    _s.last_at = 0.0  # the next read takes a new sample
    return {"ok": True, "via": via}
