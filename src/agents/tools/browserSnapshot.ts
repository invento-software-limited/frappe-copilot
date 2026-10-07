/** Runs inside one frame of the page: tags every visible interactive element
 *  with a `data-fc-ref` number (counting on from `firstRef`, so refs stay
 *  unique across frames) and returns `{ text, nextRef }`: an indented outline
 *  of the frame's headings, text, links, buttons and form fields that the
 *  model reads instead of raw HTML and acts on by ref. Kept as a string because it
 *  executes in the browser, not in the extension host. */
export const SNAPSHOT_SCRIPT = String.raw`(maxChars, firstRef) => {
  const INTERACTIVE_TAGS = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','OPTION']);
  const INTERACTIVE_ROLES = new Set(['button','link','checkbox','radio','tab','menuitem','option','combobox','textbox','switch','searchbox','treeitem']);
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','HEAD','META','LINK']);
  const BLOCK_TAGS = new Set(['H1','H2','H3','H4','H5','H6','P','LI','TR','LABEL','DIALOG','FORM','TABLE','NAV','HEADER','FOOTER','MAIN','SECTION']);

  document.querySelectorAll('[data-fc-ref]').forEach(el => el.removeAttribute('data-fc-ref'));
  let nextRef = firstRef || 1;
  const lines = [];
  let size = 0;
  let truncated = false;

  const clip = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const visible = el => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || st.display === 'contents';
  };
  const isInteractive = el => {
    if (INTERACTIVE_TAGS.has(el.tagName)) return !(el.tagName === 'INPUT' && el.type === 'hidden');
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    return ti !== null && Number(ti) >= 0;
  };
  const labelFor = el => {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title');
    if (aria) return aria;
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText; }
    if (el.labels && el.labels[0]) return el.labels[0].innerText;
    return el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('data-fieldname') || '';
  };
  const describe = el => {
    const tag = el.tagName;
    const role = el.getAttribute('role');
    if (tag === 'A') return 'link "' + clip(el.innerText || labelFor(el), 80) + '"' + (el.getAttribute('href') ? ' -> ' + clip(el.getAttribute('href'), 80) : '');
    if (tag === 'BUTTON' || role === 'button') return 'button "' + clip(el.innerText || labelFor(el), 80) + '"';
    if (tag === 'SELECT') {
      const opts = Array.from(el.options).slice(0, 15).map(o => (o.selected ? '*' : '') + clip(o.text, 30));
      return 'select "' + clip(labelFor(el), 60) + '" [' + opts.join(' | ') + ']';
    }
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'textbox "' + clip(labelFor(el), 60) + '" = "' + clip(el.value ?? el.innerText, 120) + '"';
    if (tag === 'INPUT') {
      const t = el.type || 'text';
      if (t === 'checkbox' || t === 'radio') return t + ' "' + clip(labelFor(el), 60) + '"' + (el.checked ? ' (checked)' : '');
      if (t === 'submit' || t === 'button') return 'button "' + clip(el.value || labelFor(el), 60) + '"';
      return 'input[' + t + '] "' + clip(labelFor(el), 60) + '"' + (t === 'password' ? '' : ' = "' + clip(el.value, 120) + '"') + (el.disabled ? ' (disabled)' : '');
    }
    return (role || tag.toLowerCase()) + ' "' + clip(el.innerText || labelFor(el), 80) + '"';
  };
  const push = (depth, text) => {
    if (truncated) return;
    const line = '  '.repeat(Math.min(depth, 12)) + text;
    if (size + line.length > maxChars) { truncated = true; return; }
    lines.push(line);
    size += line.length + 1;
  };

  const walk = (node, depth) => {
    if (truncated) return;
    if (node.nodeType === 3) {
      const t = clip(node.textContent, 200);
      if (t) push(depth, t);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP_TAGS.has(el.tagName.toUpperCase()) || !visible(el)) return;
    // Frames are outlined separately (each has its own document).
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') { push(depth, '[frame: ' + clip(el.getAttribute('src') || el.getAttribute('title') || '', 80) + ' — outlined below]'); return; }
    if (isInteractive(el)) {
      const ref = nextRef++;
      el.setAttribute('data-fc-ref', String(ref));
      push(depth, '[' + ref + '] ' + describe(el));
      if (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      if ((el.innerText || '').length < 120 && !el.querySelector('a,button,input,select,textarea,[role]')) return;
    }
    const tag = el.tagName;
    let childDepth = depth;
    if (/^H[1-6]$/.test(tag)) { push(depth, '#'.repeat(Number(tag[1])) + ' ' + clip(el.innerText, 150)); return; }
    if (BLOCK_TAGS.has(tag) || el.getAttribute('role') === 'dialog') childDepth = depth + 1;
    if (el.shadowRoot) el.shadowRoot.childNodes.forEach(c => walk(c, childDepth));
    el.childNodes.forEach(c => walk(c, childDepth));
  };
  if (document.body) walk(document.body, 0);

  // Collapse runs of identical lines (repeated icons, separators).
  const out = lines.filter((l, i) => l !== lines[i - 1]);
  if (truncated) out.push('… (outline truncated — scroll, or snapshot with a filter to target a section)');
  return { text: out.join('\n'), nextRef };
}`;
