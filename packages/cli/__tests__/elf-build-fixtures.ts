// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export function elfFixture(options: { machine?: number; wide?: boolean; id?: string; debug?: boolean; sections?: boolean } = {}) {
  const wide = options.wide ?? true, debug = options.debug ?? true;
  const b = Buffer.alloc(1024), id = Buffer.from(options.id ?? '1234567890abcdef', 'hex');
  b.set([0x7f, 69, 76, 70, wide ? 2 : 1, 1, 1]);
  b.writeUInt16LE(3, 16); b.writeUInt16LE(options.machine ?? (wide ? 183 : 40), 18); b.writeUInt32LE(1, 20);
  const word = (value: number, at: number) => wide ? b.writeBigUInt64LE(BigInt(value), at) : b.writeUInt32LE(value, at);
  const eh = wide ? 64 : 52, ph = wide ? 56 : 32, sh = wide ? 64 : 40;
  word(eh, wide ? 32 : 28); word(options.sections === false ? 0 : 768, wide ? 40 : 32);
  b.writeUInt16LE(eh, wide ? 52 : 40); b.writeUInt16LE(ph, wide ? 54 : 42); b.writeUInt16LE(2, wide ? 56 : 44);
  b.writeUInt16LE(sh, wide ? 58 : 46); b.writeUInt16LE(options.sections === false ? 0 : 4, wide ? 60 : 48); b.writeUInt16LE(options.sections === false ? 0 : 1, wide ? 62 : 50);
  function program(at: number, type: number, off: number, size: number, flags: number) {
    b.writeUInt32LE(type, at); b.writeUInt32LE(flags, at + (wide ? 4 : 24));
    word(off, at + (wide ? 8 : 4)); word(off, at + (wide ? 16 : 8));
    word(size, at + (wide ? 32 : 16)); word(size, at + (wide ? 40 : 20));
    word(4, at + (wide ? 48 : 28));
  }
  program(eh, 1, 0, b.length, 5); program(eh + ph, 4, 256, 16 + Math.ceil(id.length / 4) * 4, 4);
  b.writeUInt32LE(4, 256); b.writeUInt32LE(id.length, 260); b.writeUInt32LE(3, 264); b.write('GNU\0', 268, 'binary'); id.copy(b, 272);
  if (options.sections !== false) {
    const names = Buffer.from('\0.shstrtab\0.debug_info\0.debug_line\0'); names.copy(b, 512);
    function section(index: number, name: number, type: number, off: number, size: number) {
      const p = 768 + index * sh; b.writeUInt32LE(name, p); b.writeUInt32LE(type, p + 4);
      word(off, p + (wide ? 24 : 16)); word(size, p + (wide ? 32 : 20));
    }
    section(1, 1, 3, 512, names.length); section(2, 11, 1, 576, debug ? 8 : 0); section(3, 23, 1, 584, debug ? 8 : 0);
    b[576] = 7; b[584] = 9;
  }
  return b;
}
