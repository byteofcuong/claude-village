// The read-only detail panel. Everything goes in through textContent.
import type { Activity, VillagerDTO, VillagerState } from '../shared/types.js';

const STATE: Record<VillagerState, string> = { active: 'Đang làm việc', idle: 'Đang chờ', asleep: 'Đã nghỉ', error: 'Vừa gặp lỗi', 'long-running': 'Tool chạy lâu' };
const ACTIVITY: Record<Activity, string> = { thinking: 'Suy nghĩ', talking: 'Trả lời', reading: 'Đọc', building: 'Sửa file', running: 'Chạy lệnh', exploring: 'Tìm trên mạng', delegating: 'Giao việc', working: 'Dùng công cụ', resting: 'Nghỉ ngơi' };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const clock = (at: number) => (at ? new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');

export class Panel {
  private readonly root = el('aside', 'panel');
  private shownId: string | null = null;
  private lastBody = '';

  constructor(private readonly onClose: () => void) {
    this.root.hidden = true;
    document.body.append(this.root);
  }

  show(v: VillagerDTO | null, home: string, helpers: VillagerDTO[]): void {
    if (!v) {
      this.root.hidden = true;
      this.shownId = null;
      this.lastBody = '';
      return;
    }
    const body = JSON.stringify([v, home, helpers]);
    if (body === this.lastBody && this.shownId === v.id) return;
    this.lastBody = body;
    this.shownId = v.id;
    this.root.hidden = false;
    const close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Đóng');
    close.addEventListener('click', this.onClose);
    const head = el('header');
    head.append(el('p', 'eyebrow', v.kind === 'helper' ? `Người phụ việc · ${home}` : home), el('h2', '', v.title), el('p', `state state-${v.state}`, STATE[v.state]));
    const facts = el('dl');
    const fact = (k: string, val: string) => facts.append(el('dt', '', k), el('dd', '', val));
    fact('Đang', ACTIVITY[v.activity]);
    if (v.currentTool) fact('Tool', v.currentLabel ? `${v.currentTool}: ${v.currentLabel}` : v.currentTool);
    if (v.branch) fact('Branch', v.branch);
    fact('Hoạt động cuối', clock(v.lastActivityAt));
    const parts: HTMLElement[] = [close, head, facts];
    if (helpers.length) {
      parts.push(el('h3', '', 'Người phụ việc'));
      const list = el('ul', 'helpers');
      for (const h of helpers) list.append(el('li', '', `${h.title} · ${STATE[h.state]}`));
      parts.push(list);
    }
    parts.push(el('h3', '', 'Việc gần đây'));
    if (v.timeline.length) {
      const list = el('ol', 'timeline');
      for (const e of [...v.timeline].reverse()) {
        const li = el('li', e.failed ? 'failed' : '');
        li.append(el('time', '', clock(e.at)), el('span', 'tool', e.tool));
        if (e.label) li.append(el('span', 'label', e.label));
        if (e.failed) li.append(el('span', 'bad', 'lỗi'));
        list.append(li);
      }
      parts.push(list);
    } else parts.push(el('p', 'empty', 'Chưa có việc nào được ghi lại.'));
    this.root.replaceChildren(...parts);
  }
}
