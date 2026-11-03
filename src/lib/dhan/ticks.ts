export type FeedTick = {
  code: number;
  segment: number;
  securityId: string;
  ltp: number;
  bid: number;
  ask: number;
  atp: number;
  volume: number;
  oi: number;
  ts: number;
};

const SIZE: Record<number, number> = {
  2: 16,
  5: 12,
  6: 16,
  4: 50,
  8: 162,
  50: 10,
};

function textDecoderId(id: number): string {
  return String(id);
}

/** Split a Dhan v2 binary frame into ticks. Length is trusted when it fits; otherwise the known packet size. */
export function parseFeed(buffer: ArrayBuffer): FeedTick[] {
  const view = new DataView(buffer);
  const ticks: FeedTick[] = [];
  let offset = 0;
  while (offset + 8 <= view.byteLength) {
    const code = view.getUint8(offset);
    const declared = view.getUint16(offset + 1, true);
    const known = SIZE[code] ?? 0;
    let size = declared >= 8 && offset + declared <= view.byteLength ? declared : known;
    if (size < 8 || offset + size > view.byteLength) break;
    const segment = view.getUint8(offset + 3);
    const securityId = textDecoderId(view.getInt32(offset + 4, true));
    const tick = readPacket(view, offset, code, segment, securityId, size);
    if (tick) ticks.push(tick);
    offset += size;
  }
  return ticks;
}

function readPacket(
  view: DataView,
  offset: number,
  code: number,
  segment: number,
  securityId: string,
  size: number,
): FeedTick | null {
  const base = {
    code,
    segment,
    securityId,
    ltp: 0,
    bid: 0,
    ask: 0,
    atp: 0,
    volume: 0,
    oi: 0,
    ts: Date.now(),
  };
  if (code === 2 && size >= 16) {
    return {
      ...base,
      ltp: view.getFloat32(offset + 8, true),
      ts: epoch(view.getInt32(offset + 12, true)),
    };
  }
  if (code === 6 && size >= 12) {
    return { ...base, ltp: view.getFloat32(offset + 8, true) };
  }
  if (code === 5 && size >= 12) {
    return { ...base, oi: view.getInt32(offset + 8, true) };
  }
  if (code === 4 && size >= 50) {
    return {
      ...base,
      ltp: view.getFloat32(offset + 8, true),
      atp: view.getFloat32(offset + 18, true),
      ts: epoch(view.getInt32(offset + 14, true)),
      volume: view.getInt32(offset + 22, true),
    };
  }
  if (code === 8 && size >= 62) {
    const depth = offset + 62;
    const bid = size >= depth + 20 ? view.getFloat32(depth + 12, true) : 0;
    const ask = size >= depth + 20 ? view.getFloat32(depth + 16, true) : 0;
    const atp = view.getFloat32(offset + 18, true);
    return {
      ...base,
      ltp: view.getFloat32(offset + 8, true),
      atp: Number.isFinite(atp) ? atp : 0,
      ts: epoch(view.getInt32(offset + 14, true)),
      volume: view.getInt32(offset + 22, true),
      oi: view.getInt32(offset + 34, true),
      bid: Number.isFinite(bid) ? bid : 0,
      ask: Number.isFinite(ask) ? ask : 0,
    };
  }
  return null;
}

function epoch(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 1_000_000_000) return Date.now();
  return seconds * 1000;
}
