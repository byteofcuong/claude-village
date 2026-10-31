// What villagers say. Lines are written here and only ever mention the short label the detail panel
// already shows, so speech cannot carry prompts, commands or file contents.
import type { Activity } from '../shared/types.js';

export type LineKey = Activity | 'asleep' | 'error' | 'long';

const LINES: Record<LineKey, string[]> = {
  thinking: ['Để nghĩ xem nào…', 'Hừm, làm sao cho gọn đây', 'Khoan, có cách hay hơn', 'Ngẫm thêm chút đã'],
  talking: ['Xong phần này rồi nhé!', 'Báo lại cho anh chị đây', 'Để tôi kể cho nghe', 'Đại khái là thế này'],
  reading: ['Đọc kỹ rồi hẵng sửa', 'À, ra là vậy', 'Đoạn này viết hay đấy', 'Chỗ này cần xem lại'],
  building: ['Cho tôi đóng nốt cái này', 'Sửa chút là xong', 'Chỗ này phải chắc tay', 'Sắp xong rồi đây!'],
  running: ['Thử chạy xem sao', 'Đỏ lửa lên nào!', 'Chờ lò nóng đã', 'Mong là qua hết'],
  exploring: ['Đi hỏi thăm chút đã', 'Chắc ngoài kia có người biết', 'Để tìm xem sao', 'Đường này đúng không nhỉ?'],
  delegating: ['Nhờ bạn một tay nhé!', 'Việc này giao cho bạn', 'Ai rảnh giúp tôi với!', 'Chia nhau làm cho nhanh'],
  working: ['Lấy đồ nghề ra nào', 'Việc này cần đúng dụng cụ', 'Để tôi xử lý', 'Đang làm đây, đang làm đây'],
  resting: ['Uống chén trà đã', 'Trời đẹp thật', 'Nghỉ tí cho khỏe', 'Có việc thì gọi tôi nhé'],
  asleep: ['Khò… khò…', 'Zzz…', 'Mai làm tiếp…'],
  error: ['Ối, hỏng rồi!', 'Sao lại thế nhỉ?', 'Khoan đã, sai ở đâu?', 'Thử lại xem nào'],
  long: ['Việc này hơi lâu đây', 'Vẫn đang làm, đừng giục', 'Sắp được rồi, chờ chút', 'Cái này nặng thật'],
};

const WITH_LABEL: Partial<Record<LineKey, ((label: string) => string)[]>> = {
  reading: [(l) => `Để xem ${l} nào`, (l) => `Đang đọc ${l}`],
  building: [(l) => `Đang sửa ${l}`, (l) => `Sửa nốt ${l} đã`],
  running: [(l) => `Đang làm: ${l}`],
  delegating: [(l) => `Nhờ bạn: ${l}`],
  long: [(l) => `Vẫn đang: ${l}`],
};

/** Two villagers passing the time on the same island. */
export const CHATS: [string, string][] = [
  ['Hôm nay bác làm tới đâu rồi?', 'Cũng sắp xong rồi bác ạ'],
  ['Uống trà không?', 'Có, cho tôi một chén'],
  ['Trời đẹp nhỉ?', 'Ừ, mây hôm nay đẹp thật'],
  ['Có lỗi gì không đấy?', 'Mới sửa xong một cái'],
  ['Bác thấy cách này ổn không?', 'Ổn, nhưng nhớ chạy thử nhé'],
  ['Làm xong rồi đi đâu?', 'Ngồi đây ngắm mây thôi'],
];

const MAX_LABEL = 22, MAX_LINE = 38;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Picks a line. `roll` is in [0, 1); a line naming the current task is used about half the time. */
export function lineFor(key: LineKey, label: string | null, roll: number): string {
  const named = label ? WITH_LABEL[key] : undefined;
  if (named && label && roll < 0.5) return clip(named[Math.floor(roll * 2 * named.length)]!(clip(label, MAX_LABEL)), MAX_LINE);
  const plain = LINES[key];
  return plain[Math.floor(roll * plain.length)]!;
}
