import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 22, ...p }: P) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p,
});

export const IconClock = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
export const IconCalendar = (p: P) => <svg {...base(p)}><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>;
export const IconList = (p: P) => <svg {...base(p)}><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></svg>;
export const IconChart = (p: P) => <svg {...base(p)}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
export const IconSettings = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>;
export const IconUser = (p: P) => <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
export const IconCloud = (p: P) => <svg {...base(p)}><path d="M7 18a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-.5 7H7Z" /></svg>;
export const IconCloudOff = (p: P) => <svg {...base(p)}><path d="M3 3l18 18M8.5 8.7A4.5 4.5 0 0 0 7 18h11m2.5-1.5A3.5 3.5 0 0 0 19 11a6 6 0 0 0-8.3-5.5" /></svg>;
export const IconCheck = (p: P) => <svg {...base(p)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
export const IconAlert = (p: P) => <svg {...base(p)}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>;
export const IconChevronLeft = (p: P) => <svg {...base(p)}><path d="M15 18l-6-6 6-6" /></svg>;
export const IconChevronRight = (p: P) => <svg {...base(p)}><path d="M9 6l6 6-6 6" /></svg>;
export const IconPlus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const IconHome = (p: P) => <svg {...base(p)}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /></svg>;
export const IconLaptop = (p: P) => <svg {...base(p)}><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 19h20" /></svg>;
export const IconPalm = (p: P) => <svg {...base(p)}><path d="M12 22V11" /><path d="M12 11C9 6 4 7 3 9c3-1 6 0 9 2Z" /><path d="M12 11c3-5 8-4 9-2-3-1-6 0-9 2Z" /><path d="M12 11c-1-4-4-6-7-6 2 1 4 3 7 6Z" /><path d="M12 11c1-4 4-6 7-6-2 1-4 3-7 6Z" /></svg>;
export const IconBell = (p: P) => <svg {...base(p)}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>;
export const IconDownload = (p: P) => <svg {...base(p)}><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>;
export const IconTrash = (p: P) => <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>;
export const IconUndo = (p: P) => <svg {...base(p)}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>;
export const IconEdit = (p: P) => <svg {...base(p)}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
export const IconLogout = (p: P) => <svg {...base(p)}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>;
export const IconShare = (p: P) => <svg {...base(p)}><path d="M12 15V3M8 7l4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></svg>;
export const IconRefresh = (p: P) => <svg {...base(p)}><path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4" /></svg>;
export const IconX = (p: P) => <svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>;
