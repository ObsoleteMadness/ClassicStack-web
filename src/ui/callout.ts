/** Position a `position: fixed` popover under (or above) an anchor control. */

export function positionCallout(el: HTMLElement, anchor: HTMLElement): void {
  const pad = 8;
  const ar = anchor.getBoundingClientRect();
  el.style.visibility = 'hidden';
  el.hidden = false;
  const er = el.getBoundingClientRect();
  let left = ar.left;
  let top = ar.bottom + 4;
  if (left + er.width > window.innerWidth - pad) left = window.innerWidth - pad - er.width;
  if (left < pad) left = pad;
  if (top + er.height > window.innerHeight - pad) top = ar.top - er.height - 4;
  if (top < pad) top = pad;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.visibility = '';
}
