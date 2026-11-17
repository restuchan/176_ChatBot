/* ==========================================================================
   Asisten AI — logika antarmuka
   Backend: POST /api/chat  →  SSE, tiap event "data: <string JSON>", akhir "[DONE]"
   ========================================================================== */
(() => {
  'use strict';

  /* ---------- Referensi DOM ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);

  const phone      = $('#phone');
  const home       = $('#home');
  const chatTop    = $('#chatTop');
  const sheet      = $('#sheet');
  const messagesEl = $('#messages');
  const composer   = $('#composer');
  const input      = $('#input');
  const actionBtn  = $('#actionBtn');
  const newBtn     = $('#newBtn');
  const backBtn    = $('#backBtn');
  const copyBtn    = $('#copyBtn');
  const whoText    = $('#whoText');
  const busyText   = $('#busyText');
  const toastEl    = $('#toast');
  const announcer  = $('#announcer');
  const clockEl    = $('#clock');
  const greetingEl = $('#greeting');

  /* ---------- Konfigurasi ---------- */
  const FENCE = '`'.repeat(3);
  const HISTORY_LIMIT = 20;   // jumlah pesan terakhir yang dikirim ke model
  const FADE_MS = 420;        // lama teks baru "mengembun"

  const SYSTEM_PROMPT = [
    'Kamu adalah asisten AI yang ramah, jelas, dan ringkas. Jawab dalam bahasa yang dipakai pengguna (utamakan Bahasa Indonesia).',
    'Gunakan Markdown seperlunya: daftar, **teks tebal**, dan blok kode.',
    '',
    'Kamu bisa menampilkan komponen interaktif lewat blok khusus. Pakai hanya jika benar-benar membantu, letakkan di akhir jawaban,',
    'maksimal satu blok per jawaban, dan jangan menjelaskan format ini kepada pengguna.',
    '',
    '1) Jika kamu perlu informasi tambahan dari pengguna, tanyakan lewat daftar pilihan (2-5 opsi singkat):',
    FENCE + 'pilihan',
    'Judul pertanyaan singkat',
    '- Opsi pertama',
    '- Opsi kedua',
    FENCE,
    '',
    '2) Setelah menjawab lengkap, kamu boleh menyarankan langkah lanjutan (maksimal 3):',
    FENCE + 'lanjut',
    '- Judul langkah | keterangan singkat',
    '- Judul langkah | keterangan singkat',
    FENCE,
  ].join('\n');

  const reduceMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  /* ---------- State ---------- */
  const state = {
    messages: [],        // riwayat {role, content} yang dikirim ke model
    busy: false,
    runId: 0,            // penanda sesi streaming; naik saat dibatalkan/reset
    controller: null,
    listening: false,
  };
  let recognition = null;
  let stickToBottom = true;
  let uid = 0;

  /* ==========================================================================
     Util kecil
     ========================================================================== */
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };

  const esc = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const icon = (name, cls = 'ic') =>
    `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function announce(msg) {
    announcer.textContent = '';
    setTimeout(() => { announcer.textContent = msg; }, 30);
  }

  const finePointer = () => !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);

  /* ==========================================================================
     Markdown ringan (aman: semua teks di-escape dulu)
     ========================================================================== */
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0001${codes.push(c) - 1}\u0001`);
    s = s
      .replace(/\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s.replace(/\u0001(\d+)\u0001/g, (_, n) => `<code>${codes[n]}</code>`);
  }

  const inl = (s) => inline(esc(s));

  function codeBlock(lang, code) {
    return (
      '<div class="code"><div class="code-bar">' +
      `<span>${esc(lang || 'kode')}</span>` +
      `<button type="button" class="copy">${icon('copy')}<span>Salin</span></button>` +
      `</div><pre><code>${esc(code)}</code></pre></div>`
    );
  }

  function renderMarkdown(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const LIST_ANY = /^\s*([-*+]|\d+[.)])\s+/;
    const isBlockStart = (l) =>
      /^\s*(```|#{1,6}\s|>)/.test(l) || LIST_ANY.test(l) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l);
    const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
    const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;

      if (!line.trim()) { i++; continue; }

      // Blok kode
      if ((m = line.match(/^\s*```\s*([\w+#.-]*)\s*$/))) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(codeBlock(m[1], buf.join('\n')));
        continue;
      }

      // Judul
      if ((m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/))) {
        const tag = m[1].length <= 2 ? 'h3' : 'h4';
        out.push(`<${tag}>${inl(m[2])}</${tag}>`);
        i++;
        continue;
      }

      // Garis pemisah
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // Kutipan
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // Daftar
      const ul = /^\s*[-*+]\s+/.test(line);
      const ol = !ul && /^\s*\d+[.)]\s+/.test(line);
      if (ul || ol) {
        const re = ul ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
        const start = ol ? parseInt(line.match(/^\s*(\d+)/)[1], 10) : 1;
        const items = [];
        while (i < lines.length) {
          const mm = lines[i].match(re);
          if (mm) { items.push(mm[1]); i++; }
          else if (items.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ANY.test(lines[i])) {
            items[items.length - 1] += '\n' + lines[i].trim();
            i++;
          } else break;
        }
        const lis = items.map((t) => `<li>${inl(t).replace(/\n/g, '<br>')}</li>`).join('');
        out.push(ul ? `<ul>${lis}</ul>` : `<ol${start !== 1 ? ` start="${start}"` : ''}>${lis}</ol>`);
        continue;
      }

      // Tabel
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
        out.push(
          '<div class="tbl"><table><thead><tr>' +
          head.map((c) => `<th>${inl(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inl(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>'
        );
        continue;
      }

      // Paragraf
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${buf.map(inl).join('<br>')}</p>`);
    }
    return out.join('');
  }

  /* ==========================================================================
     Teks baru "mengembun": potongan yang baru tiba memudar masuk.
     Render ulang tiap frame, jadi animasi dilanjutkan dengan delay negatif.
     ========================================================================== */
  function paintMarkdown(node, html) {
    const prevLen = node._len || 0;
    node.innerHTML = html;
    const total = node.textContent.length;
    const now = performance.now();

    node._births = node._births || [];
    if (total > prevLen) node._births.push({ from: prevLen, t: now });
    node._len = total;
    node._births = node._births.filter((b) => now - b.t < FADE_MS);

    const births = node._births;
    if (!births.length || reduceMotion()) return;

    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let offset = 0;
    for (const tn of textNodes) {
      const text = tn.nodeValue;
      const start = offset;
      const end = offset + text.length;
      offset = end;

      if (end <= births[0].from) continue;
      if (tn.parentElement && tn.parentElement.closest('button')) continue;

      const frag = document.createDocumentFragment();
      let cursor = 0;
      births.forEach((b, bi) => {
        const bs = Math.max(b.from, start) - start;
        const be = Math.min(births[bi + 1] ? births[bi + 1].from : total, end) - start;
        if (be <= bs) return;
        if (bs > cursor) frag.append(text.slice(cursor, bs));
        const span = el('span', 'fresh');
        span.style.animationDelay = `-${Math.round(now - b.t)}ms`;
        span.textContent = text.slice(bs, be);
        frag.append(span);
        cursor = be;
      });
      if (!cursor) continue;
      if (cursor < text.length) frag.append(text.slice(cursor));
      tn.replaceWith(frag);
    }
  }

  /* ==========================================================================
     Memecah jawaban menjadi segmen: teks Markdown + kartu UI
     ========================================================================== */
  const stripMd = (s) => s.replace(/\*\*|`/g, '').trim();

  function parseCard(kind, body) {
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const isItem = (l) => /^[-*•]\s+/.test(l);
    const heading = lines.find((l) => !isItem(l));
    const items = lines.filter(isItem).map((l) => stripMd(l.replace(/^[-*•]\s+/, '')));

    if (kind === 'pilihan') {
      if (items.length < 2) return null;
      return { type: 'pilihan', data: { title: stripMd(heading || 'Pilih yang sesuai'), items: items.slice(0, 6) } };
    }
    const steps = items.slice(0, 4).map((t) => {
      const [title, ...rest] = t.split('|');
      return { t: title.trim(), d: rest.join('|').trim() };
    }).filter((s) => s.t);
    if (!steps.length) return null;
    return { type: 'lanjut', data: { label: stripMd(heading || 'Langkah berikutnya'), items: steps } };
  }

  function parseSegments(raw, final) {
    const segs = [];
    const pushMd = (text) => { if (text.trim()) segs.push({ type: 'md', text }); };

    let last = 0;
    let m;
    const closed = /```(pilihan|lanjut)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
    while ((m = closed.exec(raw))) {
      pushMd(raw.slice(last, m.index));
      const card = parseCard(m[1], m[2]);
      if (card) segs.push(card);
      last = closed.lastIndex;
    }

    let rest = raw.slice(last);
    const open = rest.match(/```(pilihan|lanjut)[ \t]*(?:\r?\n|$)/);
    if (open) {
      pushMd(rest.slice(0, open.index));
      const body = rest.slice(open.index + open[0].length);
      if (final) {
        const card = parseCard(open[1], body);
        if (card) segs.push(card);
      } else {
        segs.push({ type: 'pending' });
      }
      rest = '';
    } else if (!final) {
      // Pagar pembuka yang baru separuh tertulis jangan sempat tampil mentah
      const tail = rest.match(/`{1,3}[a-z]*$/);
      if (tail && [FENCE + 'pilihan', FENCE + 'lanjut'].some((c) => c.startsWith(tail[0]))) {
        rest = rest.slice(0, tail.index);
      }
    }
    pushMd(rest);
    return segs;
  }

  /* ==========================================================================
     Kartu UI hasil AI
     ========================================================================== */
  function lockCard(card, note) {
    card.setAttribute('data-locked', '');
    if (note) {
      const count = card.querySelector('.count');
      if (count) count.textContent = note;
    }
  }

  function buildChoice(data) {
    const id = `gc${++uid}`;
    const card = el('section', 'gen gen-choice');
    card.setAttribute('aria-labelledby', `${id}-t`);
    card.innerHTML =
      `<header class="gen-head">${icon('spark')}<h4 id="${id}-t"></h4>` +
      `<button type="button" class="round gen-x" aria-label="Tutup pertanyaan">${icon('close')}</button></header>` +
      '<fieldset><legend class="sr"></legend></fieldset>' +
      '<footer class="gen-foot"><span class="count" aria-live="polite">Belum dipilih</span>' +
      '<button type="button" class="skip">Lewati</button>' +
      `<button type="button" class="round go" aria-label="Kirim pilihan" disabled>${icon('arrow')}</button></footer>`;

    card.querySelector('h4').textContent = data.title;
    card.querySelector('legend').textContent = data.title;

    const fieldset = card.querySelector('fieldset');
    data.items.forEach((text) => {
      const label = el('label', 'opt');
      const box = el('input');
      box.type = 'checkbox';
      box.value = text;
      const mark = el('span', 'box');
      mark.setAttribute('aria-hidden', 'true');
      const txt = el('span', 'txt');
      txt.textContent = text;
      label.append(box, mark, txt);
      fieldset.append(label);
    });

    const count = card.querySelector('.count');
    const go = card.querySelector('.go');
    const picked = () => [...card.querySelectorAll('input:checked')].map((i) => i.value);

    fieldset.addEventListener('change', () => {
      const n = picked().length;
      count.textContent = n ? `${n} dipilih` : 'Belum dipilih';
      go.disabled = n === 0;
    });

    go.addEventListener('click', () => {
      const chosen = picked();
      if (!chosen.length) return;
      lockCard(card, `Terkirim: ${chosen.join(', ')}`);
      send(`${data.title}: ${chosen.join(', ')}`);
    });

    card.querySelector('.skip').addEventListener('click', () => {
      lockCard(card, 'Dilewati');
      send('Lewati, lanjutkan saja dengan asumsi yang paling masuk akal.');
    });

    card.querySelector('.gen-x').addEventListener('click', () => {
      card.remove();
      if (finePointer()) input.focus();
    });

    return card;
  }

  function buildNext(data) {
    const card = el('section', 'gen gen-next');
    card.innerHTML = '<p class="gen-label"></p><ul></ul>';
    card.querySelector('p').textContent = data.label;
    const list = card.querySelector('ul');

    data.items.forEach((step) => {
      const li = el('li');
      const btn = el('button', 'next-item');
      btn.type = 'button';
      btn.innerHTML =
        `<span class="next-ico">${icon('up-right')}</span>` +
        '<span class="next-txt"><b></b><small></small></span>' +
        icon('chevron', 'ic next-chev');
      btn.querySelector('b').textContent = step.t;
      const small = btn.querySelector('small');
      if (step.d) small.textContent = step.d; else small.remove();
      btn.addEventListener('click', () => send(step.t));
      li.append(btn);
      list.append(li);
    });
    return card;
  }

  function buildPending() {
    const card = el('div', 'gen gen-pending');
    card.setAttribute('aria-hidden', 'true');
    card.innerHTML = '<i></i><i></i><i></i>';
    return card;
  }

  /* ==========================================================================
     Render jawaban asisten (rekonsiliasi per segmen agar kartu tidak berkedip)
     ========================================================================== */
  function renderReply(ctx, raw, final) {
    const segs = parseSegments(raw, final);
    if (!segs.length) return false;

    if (!ctx.started) { ctx.body.textContent = ''; ctx.started = true; }

    segs.forEach((seg, i) => {
      const sig = seg.type === 'md' || seg.type === 'pending' ? seg.type : seg.type + JSON.stringify(seg.data);
      let node = ctx.nodes[i];

      if (!node || node._sig !== sig) {
        let fresh;
        if (seg.type === 'md') fresh = el('div', 'md');
        else if (seg.type === 'pending') fresh = buildPending();
        else if (seg.type === 'pilihan') fresh = buildChoice(seg.data);
        else fresh = buildNext(seg.data);
        fresh._sig = sig;
        if (!final && fresh.classList.contains('gen')) lockCard(fresh);
        if (node) node.replaceWith(fresh); else ctx.body.append(fresh);
        node = ctx.nodes[i] = fresh;
      }

      if (seg.type === 'md') paintMarkdown(node, renderMarkdown(seg.text));
    });

    while (ctx.nodes.length > segs.length) ctx.nodes.pop().remove();
    return true;
  }

  /* ==========================================================================
     Pesan
     ========================================================================== */
  function addUserMessage(text) {
    const wrap = el('div', 'msg user');
    const bubble = el('div', 'bubble');
    bubble.textContent = text;
    wrap.append(bubble);
    messagesEl.append(wrap);
    scrollDown(true);
  }

  function addAssistantMessage() {
    const wrap = el('div', 'msg assistant');
    const body = el('div', 'body');
    body.innerHTML = '<span class="thinking">Sedang berpikir…</span>';
    wrap.append(body);
    messagesEl.append(wrap);
    scrollDown(true);
    return { wrap, body, nodes: [], started: false };
  }

  function scrollDown(force) {
    if (force) stickToBottom = true;
    if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  messagesEl.addEventListener('scroll', () => {
    stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }, { passive: true });

  /* ==========================================================================
     Pengiriman & streaming
     ========================================================================== */
  function friendlyError(status) {
    if (status === 401 || status === 403) return 'Kunci API OpenRouter belum diatur atau tidak valid. Periksa file .env di server.';
    if (status === 402) return 'Kredit OpenRouter tidak cukup untuk permintaan ini.';
    if (status === 404) return 'Model yang dipilih tidak tersedia saat ini.';
    if (status === 429) return 'Batas permintaan tercapai. Tunggu sebentar, lalu coba lagi.';
    if (status >= 500) return 'Server atau penyedia model sedang bermasalah. Coba lagi sebentar lagi.';
    return `Permintaan gagal (kode ${status}).`;
  }

  function setStatus(text) {
    whoText.textContent = text;
    busyText.textContent = text;
  }

  function setBusy(busy) {
    state.busy = busy;
    composer.dataset.busy = String(busy);
    phone.dataset.busy = String(busy);
    newBtn.disabled = busy;
    composer.querySelector('.busy-status').setAttribute('aria-hidden', String(!busy));
    setStatus(busy ? 'Berpikir…' : 'Asisten');

    if (busy) {
      if (document.activeElement === input) actionBtn.focus();
      announce('Asisten sedang menjawab');
    }
    updateComposer();
  }

  function showError(ctx, message, canRetry = true) {
    ctx.body.className = 'body err';
    ctx.body.innerHTML = '<p></p>';
    ctx.body.querySelector('p').textContent = message;
    ctx.nodes = [];
    ctx.started = true;
    if (!canRetry) return;
    const retry = el('button', 'retry');
    retry.type = 'button';
    retry.innerHTML = `${icon('refresh')}<span>Coba lagi</span>`;
    retry.addEventListener('click', () => {
      if (state.busy) return;
      ctx.wrap.remove();
      streamReply();
    });
    ctx.body.append(retry);
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || state.busy) return;

    messagesEl.querySelectorAll('.gen').forEach((c) => lockCard(c));
    setView('chat');

    state.messages.push({ role: 'user', content: text });
    addUserMessage(text);

    input.value = '';
    autosize();
    updateComposer();

    await streamReply();
  }

  async function streamReply() {
    const runId = ++state.runId;
    const ctx = addAssistantMessage();
    const controller = new AbortController();
    state.controller = controller;
    setBusy(true);

    let acc = '';
    let raf = 0;
    let started = false;

    const paint = () => {
      raf = 0;
      if (runId !== state.runId) return;
      if (renderReply(ctx, acc, false)) {
        if (!started) { started = true; setStatus('Menulis…'); }
        scrollDown();
      }
    };

    try {
      const payload = [{ role: 'system', content: SYSTEM_PROMPT }, ...state.messages.slice(-HISTORY_LIMIT)];
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: payload }),
        signal: controller.signal,
      });

      if (!res.ok) throw Object.assign(new Error('http'), { status: res.status });
      if (!res.body) throw new Error('Tidak ada aliran data');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);

          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') { finished = true; break; }
            try {
              const chunk = JSON.parse(data);
              if (typeof chunk === 'string' && chunk) {
                acc += chunk;
                if (!raf) raf = requestAnimationFrame(paint);
              }
            } catch { /* potongan tidak utuh: abaikan */ }
          }
          if (finished) break;
        }
      }
      if (finished) reader.cancel().catch(() => {});
    } catch (err) {
      if (raf) cancelAnimationFrame(raf);
      if (runId !== state.runId) return;                 // sudah di-reset oleh pengguna

      if (err && err.name === 'AbortError') {
        // Dihentikan pengguna: simpan yang sudah tertulis
        if (acc.trim()) finish(ctx, acc, runId);
        else { ctx.wrap.remove(); endRun(runId); }
        return;
      }

      if (acc.trim()) {
        finish(ctx, acc, runId);
        toast('Koneksi terputus, jawaban mungkin belum lengkap.');
      } else {
        const msg = err && err.status
          ? friendlyError(err.status)
          : 'Tidak bisa terhubung ke server. Pastikan server sedang berjalan (npm start).';
        showError(ctx, msg);
        endRun(runId);
      }
      return;
    }

    if (raf) cancelAnimationFrame(raf);
    if (runId !== state.runId) return;

    if (acc.trim()) finish(ctx, acc, runId);
    else {
      showError(ctx, 'Model belum menghasilkan jawaban. Biasanya karena batas token terpakai untuk berpikir. Coba kirim ulang atau perpendek pertanyaan.');
      endRun(runId);
    }
  }

  function finish(ctx, acc, runId) {
    renderReply(ctx, acc, true);
    ctx.nodes.forEach((n) => n.classList && n.classList.contains('gen') && n.removeAttribute('data-locked'));
    state.messages.push({ role: 'assistant', content: acc });
    scrollDown();
    announce('Jawaban selesai');
    endRun(runId);
  }

  function endRun(runId) {
    if (runId !== state.runId) return;
    state.controller = null;
    setBusy(false);
    if (finePointer() && phone.dataset.view === 'chat') input.focus();
  }

  function stop() {
    if (state.controller) state.controller.abort();
  }

  /* ==========================================================================
     Tampilan: beranda ⇄ percakapan
     ========================================================================== */
  function setView(view) {
    const chat = view === 'chat';
    phone.dataset.view = view;
    home.inert = chat;
    chatTop.inert = !chat;
    sheet.inert = !chat;
  }

  function resetChat() {
    state.runId++;                       // batalkan sesi yang masih berjalan
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.messages = [];
    messagesEl.textContent = '';
    stickToBottom = true;
    if (state.listening && recognition) recognition.abort();
    input.value = '';
    autosize();
    setBusy(false);
    setView('home');
    home.scrollTop = 0;
    setGreeting();
    announce('Percakapan baru');
  }

  /* ==========================================================================
     Composer
     ========================================================================== */
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 112) + 'px';
  }

  function updateComposer() {
    const has = input.value.trim().length > 0;
    const mode = state.busy ? 'stop' : has ? 'send' : SpeechRec ? 'mic' : 'send';
    composer.dataset.mode = mode;
    actionBtn.disabled = mode === 'send' && !has;
    actionBtn.setAttribute(
      'aria-label',
      mode === 'stop' ? 'Hentikan jawaban'
        : mode === 'send' ? 'Kirim pesan'
        : state.listening ? 'Berhenti merekam' : 'Mulai input suara'
    );
  }

  input.addEventListener('input', () => { autosize(); updateComposer(); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.busy) send(input.value);
    }
  });

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const mode = composer.dataset.mode;
    if (mode === 'stop') stop();
    else if (mode === 'mic') toggleMic();
    else send(input.value);
  });

  /* Mikrofon (Web Speech API, jika didukung) */
  function toggleMic() {
    if (!SpeechRec) return;
    if (state.listening) { recognition.stop(); return; }

    recognition = new SpeechRec();
    recognition.lang = 'id-ID';
    recognition.interimResults = true;
    recognition.continuous = false;

    const base = input.value ? input.value.replace(/\s*$/, ' ') : '';
    recognition.onresult = (e) => {
      let transcript = '';
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      input.value = base + transcript;
      autosize();
      updateComposer();
    };
    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Izin mikrofon ditolak. Aktifkan lewat pengaturan browser.');
      else if (e.error === 'no-speech') toast('Tidak ada suara yang terdengar.');
      else if (e.error !== 'aborted') toast('Pengenalan suara gagal. Coba lagi.');
    };
    recognition.onend = () => {
      state.listening = false;
      composer.dataset.listening = 'false';
      updateComposer();
      if (input.value.trim() && finePointer()) input.focus();
    };

    try {
      recognition.start();
      state.listening = true;
      composer.dataset.listening = 'true';
      updateComposer();
    } catch {
      toast('Mikrofon tidak bisa dimulai.');
    }
  }

  /* Ukuran composer → ruang kosong di bawah konten */
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      phone.style.setProperty('--composer-h', Math.round(composer.offsetHeight) + 'px');
    }).observe(composer);
  }

  /* ==========================================================================
     Interaksi lain
     ========================================================================== */
  $('#suggestions').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) send(card.dataset.prompt);
  });

  backBtn.addEventListener('click', resetChat);
  newBtn.addEventListener('click', () => {
    if (phone.dataset.view === 'chat') resetChat();
    else input.focus();
  });

  /* Salin kode */
  messagesEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const code = btn.closest('.code').querySelector('code').textContent;
    const ok = await copyText(code);
    const label = btn.querySelector('span');
    label.textContent = ok ? 'Tersalin' : 'Gagal';
    setTimeout(() => { label.textContent = 'Salin'; }, 1600);
  });

  /* Salin seluruh percakapan */
  copyBtn.addEventListener('click', async () => {
    if (!state.messages.length) return;
    const text = state.messages
      .map((m) => `${m.role === 'user' ? 'Kamu' : 'Asisten'}:\n${m.content}`)
      .join('\n\n');
    toast((await copyText(text)) ? 'Percakapan disalin' : 'Tidak bisa menyalin');
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = el('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.busy) stop();
  });

  /* ==========================================================================
     Sapaan & jam
     ========================================================================== */
  function setGreeting() {
    const h = new Date().getHours();
    greetingEl.textContent =
      h >= 4 && h < 11 ? 'Selamat pagi'
      : h >= 11 && h < 15 ? 'Selamat siang'
      : h >= 15 && h < 18 ? 'Selamat sore'
      : 'Selamat malam';
  }

  function tick() {
    const d = new Date();
    clockEl.textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /* ---------- Mulai ---------- */
  setGreeting();
  tick();
  setInterval(tick, 15000);
  setView('home');
  autosize();
  updateComposer();
})();