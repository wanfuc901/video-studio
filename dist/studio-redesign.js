/* Editor shortcuts layer: additive only; existing app.js remains the source of truth. */
function setupStudioNavigation() {
  const topbar = document.querySelector('.topbar');
  if (!topbar || topbar.querySelector('.studio-quicknav')) return;
  const nav = document.createElement('nav');
  nav.className = 'studio-quicknav';
  nav.setAttribute('aria-label', 'Công cụ nhanh của Video Studio');
  const items = [
    ['media', '▦ Thư viện'],
    ['text', 'T+ Thêm chữ'],
    ['align', '✦ AI ráp lời'],
    ['timeline', '≡ Timeline'],
    ['help', '⌨ Phím tắt']
  ];
  for (const [action, title] of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = title;
    button.dataset.action = action;
    if (action === 'align') button.className = 'studio-emphasis';
    nav.appendChild(button);
  }
  const anchor = topbar.querySelector('.top-actions');
  topbar.insertBefore(nav, anchor);
  nav.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    const target = {
      media: '.media-panel',
      text: '#add-text',
      align: '#align-lyrics-button',
      timeline: '#timeline-scroll',
      help: '#shortcuts-button'
    }[action];
    if (!target) return;
    const element = document.querySelector(target);
    if (!element) return;
    if (['text', 'align', 'help'].includes(action)) element.click();
    else element.scrollIntoView({behavior:'smooth',block:'nearest',inline:'nearest'});
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupStudioNavigation);
else setupStudioNavigation();
