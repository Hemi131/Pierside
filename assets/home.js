/* Landing page behaviour: install tabs + copy, the server mock-ups, the AI demo, entrances. */
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

  /* ── AI demo: plays once when it comes into view (or on Replay) ── */
  const ai = $("[data-ai]");
  if (ai) {
    const log = $("[data-ai-log]", ai);
    const ask = $("[data-ai-ask]", ai);
    const replay = $("[data-ai-replay]", ai);
    let run = 0;
    let allowed = null;
    const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
    const line = (cls, html) => {
      const p = document.createElement("p");
      p.className = cls;
      p.innerHTML = html;
      log.appendChild(p);
      return p;
    };
    const type = async (id, text) => {
      const p = line("u", "");
      for (let i = 1; i <= text.length; i++) {
        if (id !== run) return;
        p.innerHTML = esc(text.slice(0, i)) + '<span class="ps-caret"></span>';
        await wait(22);
      }
      p.textContent = text;
    };

    const play = async () => {
      const id = ++run;
      log.innerHTML = "";
      ask.hidden = true;
      replay.hidden = true;
      const alive = () => id === run;
      await type(id, "Why does the shop's api keep restarting on production?");
      await wait(500); if (!alive()) return;
      line("a", "I'll look at the containers of the webshop project.");
      await wait(400); if (!alive()) return;
      line("t", "<b>pierside · list_containers</b> (project: webshop)");
      await wait(300); if (!alive()) return;
      const waiting = line("t", 'Waiting for approval in Pierside, code <b>K7QF</b><span class="ps-caret"></span>');
      ask.hidden = false;
      await Promise.race([new Promise((r) => { allowed = r; }), wait(2600)]);
      allowed = null;
      if (!alive()) return;
      ask.hidden = true;
      waiting.innerHTML = '<span class="ok">Allowed for this session</span>';
      await wait(500); if (!alive()) return;
      line("t", "<b>pierside · container_logs</b> (api, last 200 lines)");
      await wait(450); if (!alive()) return;
      line("t", "<b>pierside · container_health</b> (db)");
      await wait(450); if (!alive()) return;
      line("t", "<b>pierside · container_logs</b> (db, errors)");
      await wait(700); if (!alive()) return;
      line("a", 'api exits with <span class="warn">ECONNREFUSED db:5432</span> because db is unhealthy since 09:41. Its log says <span class="warn">No space left on device</span>: the server’s disk is full.');
      await wait(900); if (!alive()) return;
      line("a", "Want me to check which volumes and images take the space? I won't delete anything without asking.");
      replay.hidden = false;
    };

    $("[data-ai-allow]", ai).addEventListener("click", () => allowed && allowed());
    replay.addEventListener("click", play);
    let started = false;
    new IntersectionObserver(([entry], obs) => {
      if (entry.isIntersecting && !started) { started = true; obs.disconnect(); play(); }
    }, { threshold: 0.45 }).observe(ai);
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
