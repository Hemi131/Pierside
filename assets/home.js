/* Landing page behaviour: install tabs + copy, the server mock-ups, the terminal demos (AI access, scripts), entrances. */
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /* ── Install command: tabs and copy ── */
  for (const box of $$("[data-tabs]")) {
    const tabs = $$("[data-tab]", box);
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
        for (const p of $$("[data-panel]", box)) p.hidden = p.dataset.panel !== tab.dataset.tab;
      });
    }
  }
  for (const btn of $$(".ps-copy")) {
    btn.addEventListener("click", async () => {
      const text = btn.parentElement.querySelector("code").textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.classList.add("is-done");
        setTimeout(() => btn.classList.remove("is-done"), 1500);
      } catch { /* clipboard not allowed: the text can still be selected by hand */ }
    });
  }

  /* Runs `start` when `el` scrolls into view; `tick` every `ms` while it is in view. */
  const whenSeen = (el, start, tick, ms) => {
    if (!el) return;
    let started = false;
    let timer = null;
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        if (!started) { started = true; start && start(); }
        if (tick && !timer && !reduced) timer = setInterval(tick, ms);
      } else if (timer) { clearInterval(timer); timer = null; }
    }, { threshold: 0.3 }).observe(el);
  };
  const jitter = (v, by) => Math.max(1, Math.min(99, v + (Math.random() - 0.5) * by));

  /* ── Engines at a glance: CPU moves a little ── */
  const glance = $("[data-glance]");
  const glanceCpu = [12, 41, 68];
  whenSeen(glance, null, () => {
    for (const bar of $$("[data-g]", glance)) bar.style.width = jitter(glanceCpu[+bar.dataset.g], 10) + "%";
  }, 2000);

  /* ── Server performance: figures change in place, rows slide when the CPU order changes ── */
  const perf = $("[data-perf]");
  if (perf) {
    const PROCS = [
      { cmd: "python worker.py", ctr: "worker", cpu: 62, mem: "1.1 GB", disk: 4.2 },
      { cmd: "node server.js", ctr: "api", cpu: 41, mem: "520 MB", disk: 0.3 },
      { cmd: "postgres: writer", ctr: "db", cpu: 37, mem: "2.3 GB", disk: 11 },
      { cmd: "dockerd", ctr: "", cpu: 3, mem: "96 MB", disk: 0.1 },
      { cmd: "sshd: deploy", ctr: "", cpu: 0.3, mem: "8 MB", disk: 0 },
    ];
    const body = $("[data-procs]", perf);
    for (const p of PROCS) {
      p.now = p.cpu;
      p.row = document.createElement("tr");
      p.row.innerHTML = `<td>${esc(p.cmd)}</td><td class="${p.ctr ? "" : "is-host"}">${esc(p.ctr || "server")}</td><td data-c></td><td>${esc(p.mem)}</td><td data-d></td>`;
      body.appendChild(p.row);
    }
    const spark = $("[data-spark]", perf);
    let cpuNow = 64;
    let history = Array.from({ length: 40 }, () => jitter(64, 6));
    const fmtDisk = (v) => (v < 0.05 ? "0" : v.toFixed(1) + " MB/s");

    const draw = () => {
      // gentle drift, not noise
      cpuNow = Math.max(45, Math.min(85, cpuNow + (Math.random() - 0.5) * 6));
      const mem = 74 + Math.random() * 0.6;
      $('[data-meter="cpu"]', perf).style.width = cpuNow + "%";
      $('[data-meter="mem"]', perf).style.width = mem + "%";
      $('[data-meter-val="cpu"]', perf).textContent = Math.round(cpuNow) + " %";
      $('[data-meter-val="mem"]', perf).textContent = Math.round(mem) + " %";
      history = history.slice(1).concat(cpuNow);
      spark.setAttribute("points", history.map((v, i) => `${(i / (history.length - 1)) * 300},${40 - v * 0.42}`).join(" "));

      for (const p of PROCS) {
        p.now = Math.max(0.1, p.now + (p.cpu - p.now) * 0.3 + (Math.random() - 0.5) * Math.max(0.4, p.cpu * 0.22));
        $("[data-c]", p.row).textContent = p.now.toFixed(1) + " %";
        $("[data-d]", p.row).textContent = fmtDisk(p.disk * (0.85 + Math.random() * 0.3));
      }
      // Sorted by CPU like the real page; FLIP so a row moves instead of jumping.
      const sorted = [...PROCS].sort((a, b) => b.now - a.now);
      const current = [...body.children];
      if (sorted.some((p, i) => p.row !== current[i])) {
        const before = new Map(PROCS.map((p) => [p, p.row.getBoundingClientRect().top]));
        for (const p of sorted) body.appendChild(p.row);
        if (!reduced) {
          for (const p of PROCS) {
            const dy = before.get(p) - p.row.getBoundingClientRect().top;
            if (!dy) continue;
            p.row.style.transition = "none";
            p.row.style.transform = `translateY(${dy}px)`;
            requestAnimationFrame(() => requestAnimationFrame(() => {
              p.row.style.transition = "transform .6s ease";
              p.row.style.transform = "";
            }));
          }
        }
      }
    };
    draw();
    whenSeen(perf, null, draw, 2500);
  }

  /* ── Swarm: the failing task keeps being retried ── */
  const flaky = $("[data-flaky]");
  if (flaky && !reduced) {
    let starting = false;
    whenSeen(flaky.closest("[data-swarm]"), null, () => {
      starting = !starting;
      flaky.classList.toggle("ps-task--starting", starting);
      flaky.classList.toggle("ps-task--bad", !starting);
    }, 2200);
  }

  /* ── Server disk: folders measured two at a time ── */
  const disk = $("[data-disk]");
  if (disk) {
    const rows = $$("li", disk);
    const max = Math.max(...rows.map((li) => +li.dataset.size));
    const show = (li) => {
      const gb = +li.dataset.size;
      $("i", li).style.width = Math.max(2, (gb / max) * 100) + "%";
      const b = $("b", li);
      b.classList.remove("is-measuring");
      b.textContent = gb >= 1 ? gb.toFixed(1) + " GB" : Math.round(gb * 1024) + " MB";
    };
    for (const li of rows) { const b = $("b", li); b.textContent = "measuring…"; b.classList.add("is-measuring"); }
    whenSeen(disk, () => {
      if (reduced) { rows.forEach(show); return; }
      rows.forEach((li, i) => setTimeout(() => show(li), 500 + Math.floor(i / 2) * 700 + (i % 2) * 250));
    });
  }

  /* ── Server terminal as root ── */
  const rootTerm = $("[data-rootterm]");
  if (rootTerm) {
    const LINES = [
      ["cmd", "systemctl status nginx"],
      ["out", "● nginx.service - web server"],
      ["out", "  Loaded: loaded (enabled)"],
      ["out", '  Active: <span class="ok">active (running)</span> 3 days'],
      ["cmd", ""],
    ];
    const prompt = '<span class="root">root@prod-01</span>:/# ';
    whenSeen(rootTerm, async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
      for (const [kind, text] of LINES) {
        const p = document.createElement("p");
        rootTerm.appendChild(p);
        if (kind === "out") { p.innerHTML = text; await wait(120); continue; }
        for (let i = 0; i <= text.length; i++) {
          p.innerHTML = prompt + esc(text.slice(0, i)) + '<span class="ps-caret"></span>';
          if (text) await wait(28);
        }
        if (text) { p.innerHTML = prompt + esc(text); await wait(350); }
      }
    });
  }

  /* ── Server alerts: the two messages arrive ── */
  const toasts = $("[data-toasts]");
  whenSeen(toasts, () => toasts.classList.add("is-on"));

  /* ── Terminal demos: each plays once when it comes into view (or on Replay) ──
     `begin()` starts a play and returns its steps; starting another (Replay) makes the older play's
     steps report false (`alive`, `wait`, `type`), so it stops where it is. */
  const caret = '<span class="ps-caret"></span>';
  const player = () => {
    let run = 0;
    return () => {
      const id = ++run;
      const alive = () => id === run;
      const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms)).then(alive);
      const line = (log, cls, html, tag = "p") => {
        const p = document.createElement(tag);
        p.className = cls;
        p.innerHTML = html;
        log.appendChild(p);
        return p;
      };
      const type = async (log, text) => {
        const p = line(log, "u", "");
        for (let i = 1; i <= text.length; i++) {
          if (!alive()) return false;
          p.innerHTML = esc(text.slice(0, i)) + caret;
          await wait(22);
        }
        p.textContent = text;
        return alive();
      };
      return { alive, wait, line, type };
    };
  };
  const onSeen = (el, play) => {
    let started = false;
    new IntersectionObserver(([entry], obs) => {
      if (entry.isIntersecting && !started) { started = true; obs.disconnect(); play(); }
    }, { threshold: 0.45 }).observe(el);
  };
  /* Waits for a click on `button` or `ms`, whichever comes first. */
  const clickOr = (button, ms, wait) => new Promise((r) => {
    const done = () => { button.removeEventListener("click", done); r(); };
    button.addEventListener("click", done);
    wait(ms).then(done);
  });
  const num = (n) => n.toLocaleString("en-US");

  /* ── AI access ── */
  const ai = $("[data-ai]");
  if (ai) {
    const log = $("[data-ai-log]", ai);
    const ask = $("[data-ai-ask]", ai);
    const replay = $("[data-ai-replay]", ai);
    const begin = player();

    const play = async () => {
      const { alive, wait, line, type } = begin();
      log.innerHTML = "";
      ask.hidden = true;
      replay.hidden = true;
      if (!await type(log, "Why does the shop's api keep restarting on production?")) return;
      if (!await wait(500)) return;
      line(log, "a", "I'll look at the containers of the webshop project.");
      if (!await wait(400)) return;
      line(log, "t", "<b>pierside · list_containers</b> (project: webshop)");
      if (!await wait(300)) return;
      const waiting = line(log, "t", "Waiting for approval in Pierside, code <b>K7QF</b>" + caret);
      ask.hidden = false;
      await clickOr($("[data-ai-allow]", ai), 2600, wait);
      if (!alive()) return;
      ask.hidden = true;
      waiting.innerHTML = '<span class="ok">Allowed for this session</span>';
      if (!await wait(500)) return;
      line(log, "t", "<b>pierside · container_logs</b> (api, last 200 lines)");
      if (!await wait(450)) return;
      line(log, "t", "<b>pierside · container_health</b> (db)");
      if (!await wait(450)) return;
      line(log, "t", "<b>pierside · container_logs</b> (db, errors)");
      if (!await wait(700)) return;
      line(log, "a", 'api exits with <span class="warn">ECONNREFUSED db:5432</span> because db is unhealthy since 09:41. Its log says <span class="warn">No space left on device</span>: the server’s disk is full.');
      if (!await wait(900)) return;
      line(log, "a", "Want me to check which volumes and images take the space? I won't delete anything without asking.");
      replay.hidden = false;
    };
    replay.addEventListener("click", play);
    onSeen(ai, play);
  }

  /* ── Scripts: call by call against one script (example numbers) ── */
  const race = $("[data-race]");
  if (race) {
    const logs = { slow: $('[data-race-log="slow"]', race), fast: $('[data-race-log="fast"]', race) };
    const calls = { slow: $('[data-race-calls="slow"]', race), fast: $('[data-race-calls="fast"]', race) };
    const chars = { slow: $('[data-race-chars="slow"]', race), fast: $('[data-race-chars="fast"]', race) };
    const replay = $("[data-race-replay]", race);
    const begin = player();
    const QUESTION = "Which containers logged errors in the last hour?";
    const ANSWER = 'Two did: <span class="warn">api</span> 37 times (it can’t reach its database at 172.18.0.4:5432) and <span class="warn">worker</span> twice (job timeouts). The other 10 are clean.';
    /* [container, what the call returned, characters of its result] */
    const SLOW = [
      ["web", "no lines", 64], ["api", "37 lines", 4873], ["worker", "2 lines", 318], ["db", "no lines", 61],
      ["cache", "no lines", 66], ["proxy", "no lines", 64], ["auth", "no lines", 63], ["mail", "no lines", 64],
      ["search", "no lines", 66], ["queue", "no lines", 64], ["cron", "no lines", 63], ["metrics", "no lines", 66],
    ];
    const SCRIPT = [
      '<span class="k">for</span> c <span class="k">in</span> tools.<span class="f">list_containers</span>()[<span class="s">"containers"</span>]:',
      '    <span class="k">if</span> c[<span class="s">"state"</span>] != <span class="s">"running"</span>:',
      '        <span class="k">continue</span>',
      '    errs = tools.<span class="f">container_logs</span>(container=c[<span class="s">"name"</span>],',
      '        since_minutes=<span class="s">60</span>, contains=<span class="s">"error"</span>)[<span class="s">"lines"</span>]',
      '    <span class="k">if</span> errs:',
      '        <span class="f">print</span>(c[<span class="s">"name"</span>], len(errs), errs[-<span class="s">1</span>][<span class="s">"text"</span>])',
    ].join("\n");
    const PRINTED = ["api 37 connect ECONNREFUSED 172.18.0.4:5432", "worker 2 job 8812 failed: timeout after 30s"];
    const SUMMARY = "— 13 tool calls, 3.8 s";
    const FAST_CHARS = PRINTED.join("\n").length + SUMMARY.length + 2;

    const play = async () => {
      const step = begin();
      const { wait, line } = step;
      for (const k of ["slow", "fast"]) { logs[k].innerHTML = ""; calls[k].textContent = "0"; chars[k].textContent = "0"; }
      replay.hidden = true;
      const ask = async (k) => (await step.type(logs[k], QUESTION)) && wait(350);

      const slow = async () => {
        if (!await ask("slow")) return false;
        line(logs.slow, "a", "I'll read the error lines of each running container.");
        if (!await wait(350)) return false;
        let n = 1;
        let read = 2412;
        line(logs.slow, "t", "<b>pierside · list_containers</b> 12 running");
        calls.slow.textContent = "1";
        chars.slow.textContent = num(read);
        for (const [name, got, size] of SLOW) {
          if (!await wait(300)) return false;
          line(logs.slow, "t", `<b>pierside · container_logs</b> ${name}: ${got}`);
          calls.slow.textContent = String(++n);
          chars.slow.textContent = num(read += size);
        }
        if (!await wait(500)) return false;
        line(logs.slow, "a", ANSWER);
        return true;
      };

      const fast = async () => {
        if (!await ask("fast")) return false;
        line(logs.fast, "a", "I'll do it in one script.");
        if (!await wait(350)) return false;
        line(logs.fast, "t", "<b>pierside · run_script</b>");
        line(logs.fast, "ps-script", SCRIPT, "pre");
        calls.fast.textContent = "1";
        if (!await wait(400)) return false;
        const inside = line(logs.fast, "o dim", "");
        for (let i = 1; i <= 13; i++) {
          inside.innerHTML = `in the sandbox: ${i} call${i > 1 ? "s" : ""}, each checked by Pierside` + caret;
          if (!await wait(90)) return false;
        }
        inside.remove();
        for (const text of PRINTED) line(logs.fast, "o", esc(text));
        line(logs.fast, "o dim", SUMMARY);
        chars.fast.textContent = num(FAST_CHARS);
        if (!await wait(500)) return false;
        line(logs.fast, "a", ANSWER);
        return true;
      };

      const [a, b] = await Promise.all([slow(), fast()]);
      if (a && b) replay.hidden = false;
    };
    replay.addEventListener("click", play);
    onSeen(race, play);
  }

  /* ── Scripts: a plan of changes, allowed in Pierside ── */
  const plan = $("[data-plan]");
  if (plan) {
    const log = $("[data-plan-log]", plan);
    const ask = $("[data-plan-ask]", plan);
    const replay = $("[data-plan-replay]", plan);
    const begin = player();
    const SCRIPT = [
      'eng = <span class="s">"staging"</span>',
      '<span class="k">for</span> v <span class="k">in</span> tools.<span class="f">list_volumes</span>(engine=eng)[<span class="s">"volumes"</span>]:',
      '    <span class="k">if</span> <span class="k">not</span> v[<span class="s">"usedBy"</span>]:',
      '        tools.<span class="f">delete_volume</span>(engine=eng, volume=v[<span class="s">"name"</span>])',
      '        <span class="f">print</span>(<span class="s">"deleted"</span>, v[<span class="s">"name"</span>])',
    ].join("\n");

    const play = async () => {
      const { alive, wait, line, type } = begin();
      log.innerHTML = "";
      ask.hidden = true;
      replay.hidden = true;
      if (!await type(log, "Delete the volumes nothing uses on staging.")) return;
      if (!await wait(500)) return;
      line(log, "a", "I'll do it in one script. Pierside will show you what it would delete first.");
      if (!await wait(400)) return;
      line(log, "t", "<b>pierside · run_script</b>");
      line(log, "ps-script", SCRIPT, "pre");
      if (!await wait(500)) return;
      line(log, "o dim", "planning run: 3 changes found, none made");
      if (!await wait(400)) return;
      const waiting = line(log, "t", "Waiting for you to allow the changes in Pierside" + caret);
      ask.hidden = false;
      await clickOr($("[data-plan-allow]", plan), 3200, wait);
      if (!alive()) return;
      ask.hidden = true;
      waiting.innerHTML = '<span class="ok">3 changes allowed</span>';
      if (!await wait(500)) return;
      line(log, "o dim", "second run, in a fresh sandbox:");
      for (const name of ["cache_old", "build_tmp", "test_db_2024"]) {
        if (!await wait(350)) return;
        line(log, "o", "deleted " + name);
      }
      if (!await wait(300)) return;
      line(log, "o dim", "— 4 tool calls, 3 of 3 allowed changes made");
      if (!await wait(600)) return;
      line(log, "a", "Done: cache_old, build_tmp and test_db_2024 are gone. Nothing else was touched.");
      replay.hidden = false;
    };
    replay.addEventListener("click", play);
    onSeen(plan, play);
  }

  /* ── Entrances ── */
  const reveals = $$(".ps-reveal");
  if (!("IntersectionObserver" in window) || reduced) {
    for (const el of reveals) el.classList.add("is-in");
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
    }, { threshold: 0.12 });
    for (const el of reveals) io.observe(el);
  }
})();
