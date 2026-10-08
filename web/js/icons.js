/**
 * KBPRO — 图标库（内联 SVG，stroke 1.6，16×16 网格）
 */
const P = {
  home: '<path d="M2.5 6.6 8 2.4l5.5 4.2V13a.9.9 0 0 1-.9.9H3.4a.9.9 0 0 1-.9-.9z"/><path d="M6.3 13.9V9h3.4v4.9"/>',
  file: '<path d="M9.2 1.9H4.6a1.3 1.3 0 0 0-1.3 1.3v9.6a1.3 1.3 0 0 0 1.3 1.3h6.8a1.3 1.3 0 0 0 1.3-1.3V5.3z"/><path d="M9.2 1.9v3.4h3.5"/>',
  files: '<path d="M4.6 4.4V3.2a1.3 1.3 0 0 1 1.3-1.3h3.8l3.5 3.4v6.3a1.3 1.3 0 0 1-1.3 1.3h-1"/><path d="M2.6 5.9h4l3.4 3.3v5.3a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2z"/>',
  note: '<path d="M11.4 2.3H4.6a1.3 1.3 0 0 0-1.3 1.3v8.8a1.3 1.3 0 0 0 1.3 1.3h6.8a1.3 1.3 0 0 0 1.3-1.3V4.6z"/><path d="M5.6 5.9h4.8M5.6 8.4h4.8M5.6 10.9h2.9"/>',
  folder: '<path d="M2.2 12.4V3.9a.8.8 0 0 1 .8-.8h3l1.5 1.7h5.5a.8.8 0 0 1 .8.8v6.8a.8.8 0 0 1-.8.8H3a.8.8 0 0 1-.8-.8z"/>',
  folderOpen: '<path d="M2.2 12.4V3.9a.8.8 0 0 1 .8-.8h3l1.5 1.7h5.5a.8.8 0 0 1 .8.8v1.2"/><path d="M2.2 12.4 4 7.4h10.2l-1.8 5z"/>',
  sparkle: '<path d="M8 1.8 9.6 6 13.8 7.6 9.6 9.2 8 13.4 6.4 9.2 2.2 7.6 6.4 6z"/><path d="M12.6 1.6v2M11.6 2.6h2"/>',
  sparkles: '<path d="M6.2 1.9 7.4 5.1l3.2 1.2-3.2 1.2L6.2 10.7 5 7.5 1.8 6.3 5 5.1z"/><path d="M12.2 8.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>',
  search: '<circle cx="7.1" cy="7.1" r="4.6"/><path d="m10.6 10.6 3 3"/>',
  users: '<path d="M10.9 13.6v-1.3a2.5 2.5 0 0 0-2.5-2.5H4.4a2.5 2.5 0 0 0-2.5 2.5v1.3"/><circle cx="6.4" cy="5.2" r="2.4"/><path d="M14.1 13.6v-1.3a2.5 2.5 0 0 0-1.9-2.4"/><path d="M10.4 2.9a2.5 2.5 0 0 1 0 4.7"/>',
  user: '<circle cx="8" cy="5.2" r="2.6"/><path d="M2.9 13.8a5.1 5.1 0 0 1 10.2 0"/>',
  trash: '<path d="M2.7 4.3h10.6"/><path d="M12.1 4.3v8.3a1.2 1.2 0 0 1-1.2 1.2H5.1a1.2 1.2 0 0 1-1.2-1.2V4.3"/><path d="M6.2 4.3V3.1a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.2"/><path d="M6.6 7.2v4.4M9.4 7.2v4.4"/>',
  shield: '<path d="M8 1.9 3.1 3.9v4.4c0 3 2.1 5.4 4.9 6.2 2.8-.8 4.9-3.2 4.9-6.2V3.9z"/><path d="m6.1 8 1.4 1.4 2.5-2.6"/>',
  upload: '<path d="M14 10.6v2.1a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 12.7v-2.1"/><path d="M11.3 5.4 8 2.1 4.7 5.4"/><path d="M8 2.1v8.6"/>',
  download: '<path d="M14 10.6v2.1a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 12.7v-2.1"/><path d="M4.7 7.4 8 10.7l3.3-3.3"/><path d="M8 10.7V2.1"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  minus: '<path d="M3.2 8h9.6"/>',
  check: '<path d="m3.2 8.4 3.3 3.3 6.3-7.4"/>',
  close: '<path d="M3.8 3.8 12.2 12.2M12.2 3.8 3.8 12.2"/>',
  more: '<circle cx="3.4" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.6" cy="8" r="1.1"/>',
  moreV: '<circle cx="8" cy="3.4" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="8" cy="12.6" r="1.1"/>',
  chevronRight: '<path d="m6.2 3.6 4.4 4.4-4.4 4.4"/>',
  chevronDown: '<path d="m3.6 6.2 4.4 4.4 4.4-4.4"/>',
  chevronLeft: '<path d="M9.8 3.6 5.4 8l4.4 4.4"/>',
  chevronUp: '<path d="M3.6 9.8 8 5.4l4.4 4.4"/>',
  arrowLeft: '<path d="M12.6 8H3.4"/><path d="M7.2 3.8 3 8l4.2 4.2"/>',
  arrowRight: '<path d="M3.4 8h9.2"/><path d="M8.8 3.8 13 8l-4.2 4.2"/>',
  star: '<path d="m8 1.9 1.85 3.9 4.15.6-3 3 .7 4.3L8 11.65 4.3 13.7l.7-4.3-3-3 4.15-.6z"/>',
  starFill: '<path fill="currentColor" stroke="none" d="m8 1.9 1.85 3.9 4.15.6-3 3 .7 4.3L8 11.65 4.3 13.7l.7-4.3-3-3 4.15-.6z"/>',
  pin: '<path d="M5.9 1.9h4.2l-.5 3.4 2.2 2.2H4.2l2.2-2.2z"/><path d="M8 7.5v6.6"/>',
  pinFill: '<path fill="currentColor" stroke="none" d="M5.9 1.9h4.2l-.5 3.4 2.2 2.2H4.2l2.2-2.2z"/><path d="M8 7.5v6.6"/>',
  edit: '<path d="M11.4 2.4a1.7 1.7 0 0 1 2.4 2.4L5.6 13 2.2 13.8l.8-3.4z"/><path d="m10 3.8 2.2 2.2"/>',
  copy: '<rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.2"/><path d="M10.6 5.4V3.6a1.2 1.2 0 0 0-1.2-1.2H3.6a1.2 1.2 0 0 0-1.2 1.2v5.8a1.2 1.2 0 0 0 1.2 1.2h1.8"/>',
  move: '<path d="M8 1.9v12.2M1.9 8h12.2"/><path d="m5.6 4.3 2.4-2.4 2.4 2.4M5.6 11.7 8 14.1l2.4-2.4M4.3 5.6 1.9 8l2.4 2.4M11.7 5.6 14.1 8l-2.4 2.4"/>',
  link: '<path d="M6.6 8.8a2.6 2.6 0 0 0 3.9.3l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-1.1 1.1"/><path d="M9.4 7.2a2.6 2.6 0 0 0-3.9-.3L3.6 8.8a2.6 2.6 0 0 0 3.7 3.7l1.1-1.1"/>',
  share: '<circle cx="11.6" cy="3.6" r="2.1"/><circle cx="4.4" cy="8" r="2.1"/><circle cx="11.6" cy="12.4" r="2.1"/><path d="m6.3 7 3.4-2M6.3 9l3.4 2"/>',
  comment: '<path d="M13.4 9.6a1.4 1.4 0 0 1-1.4 1.4H4.9l-2.3 2.1V4a1.4 1.4 0 0 1 1.4-1.4h8a1.4 1.4 0 0 1 1.4 1.4z"/>',
  clock: '<circle cx="8" cy="8" r="6.1"/><path d="M8 4.3V8l2.5 1.5"/>',
  restore: '<path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9"/><path d="M2.2 2.4v3.2h3.2"/><path d="M8 5.1V8l2.2 1.4"/>',
  history: '<path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9"/><path d="M2.2 2.4v3.2h3.2"/><path d="M8 5.1V8l2.2 1.4"/>',
  settings: '<circle cx="8" cy="8" r="2"/><path d="M12.9 9.9a1.1 1.1 0 0 0 .2 1.2l.1.1a1.3 1.3 0 1 1-1.9 1.9l-.1-.1a1.1 1.1 0 0 0-1.2-.2 1.1 1.1 0 0 0-.7 1v.2a1.3 1.3 0 1 1-2.6 0v-.1a1.1 1.1 0 0 0-.7-1 1.1 1.1 0 0 0-1.2.2l-.1.1a1.3 1.3 0 1 1-1.9-1.9l.1-.1a1.1 1.1 0 0 0 .2-1.2 1.1 1.1 0 0 0-1-.7h-.2a1.3 1.3 0 1 1 0-2.6h.1a1.1 1.1 0 0 0 1-.7 1.1 1.1 0 0 0-.2-1.2l-.1-.1a1.3 1.3 0 1 1 1.9-1.9l.1.1a1.1 1.1 0 0 0 1.2.2h.1a1.1 1.1 0 0 0 .7-1v-.2a1.3 1.3 0 1 1 2.6 0v.1a1.1 1.1 0 0 0 .7 1 1.1 1.1 0 0 0 1.2-.2l.1-.1a1.3 1.3 0 1 1 1.9 1.9l-.1.1a1.1 1.1 0 0 0-.2 1.2v.1a1.1 1.1 0 0 0 1 .7h.2a1.3 1.3 0 1 1 0 2.6h-.1a1.1 1.1 0 0 0-1 .7z"/>',
  logout: '<path d="M6.2 13.6H3.4A1.4 1.4 0 0 1 2 12.2V3.8a1.4 1.4 0 0 1 1.4-1.4h2.8"/><path d="m10.6 11.2 3.2-3.2-3.2-3.2"/><path d="M13.8 8H6.1"/>',
  refresh: '<path d="M13.6 7.2a5.6 5.6 0 0 0-9.7-3.4L2.4 5.3"/><path d="M2.4 2.6v2.7h2.7"/><path d="M2.4 8.8a5.6 5.6 0 0 0 9.7 3.4l1.5-1.5"/><path d="M13.6 13.4v-2.7h-2.7"/>',
  filter: '<path d="M6.4 13.6V8.9L2.6 3.4a.6.6 0 0 1 .5-1h9.8a.6.6 0 0 1 .5 1L9.6 8.9v4.7l-3.2 1.4z"/>',
  sort: '<path d="M4.4 3.2v9.6M2.2 10.6l2.2 2.2 2.2-2.2"/><path d="M11.6 12.8V3.2M9.4 5.4l2.2-2.2 2.2 2.2"/>',
  grid: '<rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1"/><rect x="9" y="2.4" width="4.6" height="4.6" rx="1"/><rect x="2.4" y="9" width="4.6" height="4.6" rx="1"/><rect x="9" y="9" width="4.6" height="4.6" rx="1"/>',
  list: '<path d="M5.4 4h8.2M5.4 8h8.2M5.4 12h8.2"/><circle cx="2.8" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="2.8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="2.8" cy="12" r=".9" fill="currentColor" stroke="none"/>',
  eye: '<path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/>',
  info: '<circle cx="8" cy="8" r="6.1"/><path d="M8 10.8V7.4M8 5.4h.01"/>',
  alert: '<path d="M7.1 2.6 2 12.2a1 1 0 0 0 .9 1.5h10.2a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0z"/><path d="M8 6.3v3.1M8 11.6h.01"/>',
  success: '<circle cx="8" cy="8" r="6.1"/><path d="m5.6 8.2 1.7 1.7 3.3-3.8"/>',
  error: '<circle cx="8" cy="8" r="6.1"/><path d="M10.2 5.8 5.8 10.2M5.8 5.8l4.4 4.4"/>',
  bold: '<path d="M4.4 2.6h4.2a2.7 2.7 0 0 1 0 5.4H4.4z"/><path d="M4.4 8h4.9a2.7 2.7 0 0 1 0 5.4H4.4z"/>',
  italic: '<path d="M6.6 2.6h4.8M4.6 13.4h4.8M9.6 2.6 6.4 13.4"/>',
  underline: '<path d="M4 2.4v5.2a4 4 0 0 0 8 0V2.4"/><path d="M3.2 13.6h9.6"/>',
  strike: '<path d="M2.6 8h10.8"/><path d="M11.2 5.1A3.2 3.2 0 0 0 8.4 3.2c-1.7 0-3 .9-3 2.3 0 .8.5 1.4 1.3 1.9"/><path d="M4.9 10.6c.3 1.3 1.6 2.2 3.3 2.2 1.8 0 3.1-.9 3.1-2.3 0-.5-.2-1-.5-1.4"/>',
  h1: '<path d="M3 3.2v9.6M9 3.2v9.6M3 8h6"/><path d="M11.6 6.6 13.4 5.6v7.2"/>',
  h2: '<path d="M2.4 3.2v9.6M7.6 3.2v9.6M2.4 8h5.2"/><path d="M10.6 7.4a1.8 1.8 0 1 1 2.9 1.9l-2.9 3.4h3.2"/>',
  h3: '<path d="M2.4 3.2v9.6M7.6 3.2v9.6M2.4 8h5.2"/><path d="M10.2 5.7h3l-1.7 2.2a1.7 1.7 0 1 1-1.4 2.7"/>',
  quote: '<path d="M6.6 4.4C4.9 5.2 4 6.6 4 8.4v3.2h3.4V8.4H5.9c0-1.2.5-2 1.6-2.5z"/><path d="M12.2 4.4c-1.7.8-2.6 2.2-2.6 4v3.2h3.4V8.4h-1.5c0-1.2.5-2 1.6-2.5z"/>',
  code: '<path d="m6 4.4-3.4 3.6L6 11.6"/><path d="m10 4.4 3.4 3.6L10 11.6"/>',
  codeBlock: '<rect x="1.9" y="3.4" width="12.2" height="9.2" rx="1.4"/><path d="m6 6.6-1.6 1.6L6 9.8M10 6.6l1.6 1.6L10 9.8"/>',
  ul: '<path d="M5.4 4h8.2M5.4 8h8.2M5.4 12h8.2"/><circle cx="2.6" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="2.6" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="2.6" cy="12" r="1" fill="currentColor" stroke="none"/>',
  ol: '<path d="M6 4h7.6M6 8h7.6M6 12h7.6"/><path d="M2 3.2 3 2.6v3M1.7 8.7c0-.6.5-1 1.1-1s1 .4 1 .9c0 .9-2 1.3-2 2.4h2.1"/>',
  table: '<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.2"/><path d="M2.2 6.6h11.6M2.2 9.9h11.6M6.2 6.6v6.2M9.9 6.6v6.2"/>',
  image: '<rect x="2.2" y="3" width="11.6" height="10" rx="1.4"/><circle cx="6" cy="6.6" r="1.1"/><path d="m13.8 10.4-3.2-3-4.4 5.6"/>',
  divider: '<path d="M2.6 8h10.8"/><path d="M4.4 4.4h7.2M4.4 11.6h7.2" opacity=".4"/>',
  tag: '<path d="M8.4 2.2H3.4a1.2 1.2 0 0 0-1.2 1.2v5l7.2 7.2a1.2 1.2 0 0 0 1.7 0l4.5-4.5a1.2 1.2 0 0 0 0-1.7z"/><circle cx="5.6" cy="5.6" r="1"/>',
  layers: '<path d="m8 2 6 3.2-6 3.2-6-3.2z"/><path d="m2 8.4 6 3.2 6-3.2"/><path d="m2 11.6 6 3.2 6-3.2"/>',
  database: '<ellipse cx="8" cy="4.1" rx="5.4" ry="2.2"/><path d="M2.6 4.1v7.8c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V4.1"/><path d="M2.6 8c0 1.2 2.4 2.2 5.4 2.2S13.4 9.2 13.4 8"/>',
  cloud: '<path d="M11.2 12.2H4.6a3 3 0 0 1-.4-6 4 4 0 0 1 7.7 1 2.5 2.5 0 0 1-.7 5z"/>',
  activity: '<path d="M14 8H10.6l-1.6 4.4L6.6 3.6 5 8H2"/>',
  chart: '<path d="M2.4 13.6h11.2"/><path d="M4.8 11.2V6.6M7.6 11.2V3.6M10.4 11.2V8.4M13.2 11.2V5.2"/>',
  lock: '<rect x="3.2" y="7" width="9.6" height="6.4" rx="1.4"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7"/>',
  unlock: '<rect x="3.2" y="7" width="9.6" height="6.4" rx="1.4"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.6-.8"/>',
  key: '<circle cx="5.4" cy="10.6" r="2.6"/><path d="m7.3 8.7 5.3-5.3M10.4 5.6l1.6 1.6M12 4l1.6 1.6"/>',
  mail: '<rect x="2" y="3.4" width="12" height="9.2" rx="1.4"/><path d="m2.4 4.4 5.6 4 5.6-4"/>',
  calendar: '<rect x="2.2" y="3.4" width="11.6" height="10.2" rx="1.4"/><path d="M2.2 6.6h11.6M5.4 2.2v2.4M10.6 2.2v2.4"/>',
  send: '<path d="M14 2 7.3 8.7"/><path d="M14 2 9.7 14l-2.4-5.3L2 6.3z"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.4"/>',
  external: '<path d="M9.6 2.6h3.8v3.8"/><path d="m13.4 2.6-5.6 5.6"/><path d="M12 9.4v3.2a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 12.6V5.4A1.4 1.4 0 0 1 3.4 4h3.2"/>',
  expand: '<path d="M6 2.4H2.4V6"/><path d="M10 13.6h3.6V10"/><path d="M13.6 6V2.4H10"/><path d="M2.4 10v3.6H6"/>',
  book: '<path d="M2.4 3.2A1.2 1.2 0 0 1 3.6 2h3.2a1.4 1.4 0 0 1 1.2 1.4v9.4a1.2 1.2 0 0 0-1.2-1H2.4z"/><path d="M13.6 3.2A1.2 1.2 0 0 0 12.4 2H9.2A1.4 1.4 0 0 0 8 3.4v9.4a1.2 1.2 0 0 1 1.2-1h4.4z"/>',
  bulb: '<path d="M6.2 11.4a4.4 4.4 0 1 1 3.6 0v1.6a.8.8 0 0 1-.8.8H7a.8.8 0 0 1-.8-.8z"/><path d="M6.4 13.8h3.2"/>',
  mic: '<rect x="6" y="1.9" width="4" height="7.2" rx="2"/><path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0"/><path d="M8 12v2.1"/>',
  robot: '<rect x="2.4" y="4.4" width="11.2" height="8.4" rx="2"/><path d="M8 1.9v2.5M5.6 8h.01M10.4 8h.01M6 10.2h4"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M12.7 3.3l-1 1M4.3 11.7l-1 1"/>',
  moon: '<path d="M13.2 9.4A5.6 5.6 0 0 1 6.6 2.8a5.6 5.6 0 1 0 6.6 6.6z"/>',
  zoomIn: '<circle cx="7.1" cy="7.1" r="4.6"/><path d="m10.6 10.6 3 3M5.4 7.1h3.4M7.1 5.4v3.4"/>',
  zoomOut: '<circle cx="7.1" cy="7.1" r="4.6"/><path d="m10.6 10.6 3 3M5.4 7.1h3.4"/>',
  archive: '<rect x="2" y="2.6" width="12" height="3.4" rx="1"/><path d="M3.2 6v6.6a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4V6"/><path d="M6.6 9.2h2.8"/>',
  compass: '<circle cx="8" cy="8" r="6.1"/><path d="m10.4 5.6-1.6 4.2-4.2 1.6 1.6-4.2z"/>',
  target: '<circle cx="8" cy="8" r="6.1"/><circle cx="8" cy="8" r="3.4"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/>',
  hash: '<path d="M6 2.4 4.8 13.6M11.2 2.4 10 13.6M2.6 5.8h10.8M2.2 10.2h10.8"/>',
  loader: '<path d="M8 1.9v2.4M8 11.7v2.4M1.9 8h2.4M11.7 8h2.4M3.7 3.7l1.7 1.7M10.6 10.6l1.7 1.7M12.3 3.7l-1.7 1.7M5.4 10.6l-1.7 1.7"/>',
  bell: '<path d="M12 6.4a4 4 0 0 0-8 0c0 4.2-1.6 5.4-1.6 5.4h11.2S12 10.6 12 6.4z"/><path d="M9.2 14a1.5 1.5 0 0 1-2.4 0"/>',
  inbox: '<path d="M14 9.4h-3.2l-.9 1.6H6.1l-.9-1.6H2"/><path d="M4.1 2.6h7.8L14 9.4v2.8a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 12.2V9.4z"/>',
  wand: '<path d="m2.6 13.4 7.2-7.2M11.4 2.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/><path d="m5.2 2.6.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3L3.4 4.4l1.3-.5z"/>',
  branch: '<circle cx="4.4" cy="3.4" r="1.8"/><circle cx="4.4" cy="12.6" r="1.8"/><circle cx="11.6" cy="6.4" r="1.8"/><path d="M4.4 5.2v5.6M6.2 6.4h3.6a1.8 1.8 0 0 0 1.8-1.8v0"/>',
  globe: '<circle cx="8" cy="8" r="6.1"/><path d="M1.9 8h12.2"/><path d="M8 1.9c1.6 1.7 2.4 3.8 2.4 6.1S9.6 12.4 8 14.1C6.4 12.4 5.6 10.3 5.6 8S6.4 3.6 8 1.9z"/>',
  clipboard: '<rect x="3.4" y="2.6" width="9.2" height="11" rx="1.4"/><path d="M6.2 2.6V1.9a.9.9 0 0 1 .9-.9h1.8a.9.9 0 0 1 .9.9v.7z"/>',
  zap: '<path d="M8.8 1.9 3.4 9h4.2l-.4 5.1L12.6 7H8.4z"/>',
  scale: '<path d="M8 2.2v11.6"/><path d="M3 4.6h10"/><path d="M5.2 4.6 3 8.6h4.4z"/><path d="M10.8 4.6 8.6 8.6H13z"/><path d="M5.6 13.8h4.8"/>',
  sun2: '<circle cx="8" cy="8" r="3"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"/>'
};

export const ICON_NAMES = Object.keys(P);

/** 未显式指定尺寸时的默认图标边长（px） */
export const DEFAULT_ICON_SIZE = 16;

/**
 * 生成内联 SVG 图标。
 *
 * 尺寸**必须**总是写出：app.css 没有全局 svg 尺寸规则，若不写 width/height，
 * 浏览器会按替换元素默认尺寸（300×150）渲染——放在 flex 行里就会变成一个巨大的图标。
 * 需要交给 CSS 控制的场景不受影响：CSS 的 width/height 优先级高于这两个表现属性。
 *
 * @param {string} name
 * @param {number|string} [size] 边长，默认 16
 * @param {string} [cls]
 */
export function icon(name, size = DEFAULT_ICON_SIZE, cls = '') {
  const d = P[name] || P.file;
  const px = size || DEFAULT_ICON_SIZE;
  const c = cls ? ` class="${cls}"` : '';
  return `<svg width="${px}" height="${px}"${c} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(P, name);
}
