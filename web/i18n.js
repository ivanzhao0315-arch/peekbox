// Two languages, no framework: `t(zh, en)` in scripts, `data-en` on static markup (HTML allowed), `data-lang="zh|en"`
// blocks for long prose. The choice lives in localStorage (tape-lang); the browser's language is the default.
(() => {
  let saved = null; try { saved = localStorage.getItem('tape-lang'); } catch {}
  const lang = saved === 'zh' || saved === 'en' ? saved : ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
  window.LANG = lang;
  window.t = (zh, en) => (lang === 'zh' ? zh : en);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  const apply = () => {
    if (lang === 'en') {
      for (const el of document.querySelectorAll('[data-en]')) el.innerHTML = el.dataset.en;
      for (const el of document.querySelectorAll('[data-en-title]')) el.title = el.dataset.enTitle;
      for (const el of document.querySelectorAll('[data-en-value]')) el.value = el.dataset.enValue;
      for (const el of document.querySelectorAll('[data-en-placeholder]')) el.placeholder = el.dataset.enPlaceholder;
      const title = document.querySelector('title[data-en]'); if (title) document.title = title.dataset.en;
    }
    for (const el of document.querySelectorAll('[data-lang]')) el.hidden = el.dataset.lang !== lang;
    const bar = document.querySelector('.topbar');
    if (bar && !document.getElementById('langBtn')) {
      const b = document.createElement('button'); b.id = 'langBtn'; b.className = 'btn ghost sm'; b.textContent = lang === 'zh' ? 'EN' : '中文'; b.title = lang === 'zh' ? 'Switch to English' : '切换到中文';
      b.onclick = () => { try { localStorage.setItem('tape-lang', lang === 'zh' ? 'en' : 'zh'); } catch {} location.reload(); };
      const spacer = bar.querySelector('.spacer'); if (spacer) spacer.after(b); else bar.append(b);
    }
  };
  if (document.body) apply(); else document.addEventListener('DOMContentLoaded', apply);
})();
