// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { ElfBuildImage } from './elf-build.js';
const invalid = () => new Error('invalid_elf_binary');
/** Local identity and debug-section presence only; the service validates DWARF. */
export function parseElfBuildImage(b: Buffer): {
    image: ElfBuildImage;
    hasDebugInfo: boolean;
} {
    if (b.length < 52 || b.length > 64 * 1024 * 1024 || b.readUInt32BE(0) !== 0x7f454c46 || ![1, 2].includes(b[4]!) || b[5] !== 1 || b[6] !== 1)
        throw invalid();
    const wide = b[4] === 2, eh = wide ? 64 : 52, ph = wide ? 56 : 32, sh = wide ? 64 : 40;
    if (b.length < eh || ![2, 3].includes(b.readUInt16LE(16)) || b.readUInt32LE(20) !== 1 || b.readUInt16LE(wide ? 52 : 40) !== eh)
        throw invalid();
    const machine = b.readUInt16LE(18);
    const abi: ElfBuildImage['abi'] | undefined = wide ? ({ 183: 'arm64-v8a', 62: 'x86_64', 243: 'riscv64' } as const)[machine as 183] : ({ 40: 'armeabi-v7a', 3: 'x86' } as const)[machine as 40];
    if (!abi)
        throw new Error('unsupported_elf_architecture');
    const word = (at: number) => wide ? b.readBigUInt64LE(at) : BigInt(b.readUInt32LE(at));
    function range(offset: bigint, size: bigint): [
        number,
        number
    ] {
        if (offset > BigInt(b.length) || size > BigInt(b.length) - offset)
            throw invalid();
        return [Number(offset), Number(size)];
    }
    const phCount = b.readUInt16LE(wide ? 56 : 44), shCount = b.readUInt16LE(wide ? 60 : 48), stringIndex = b.readUInt16LE(wide ? 62 : 50);
    if (!phCount || phCount > 1024 || b.readUInt16LE(wide ? 54 : 42) !== ph || shCount > 8192 || stringIndex === 65535)
        throw invalid();
    const [phOffset] = range(word(wide ? 32 : 28), BigInt(phCount * ph));
    if (phOffset < eh)
        throw invalid();
    const sectionOffset = word(wide ? 40 : 32);
    if ((!shCount && (sectionOffset !== 0n || stringIndex !== 0)) || (shCount && (sectionOffset < BigInt(eh) || b.readUInt16LE(wide ? 58 : 46) !== sh || stringIndex >= shCount)))
        throw invalid();
    const [shOffset] = range(sectionOffset, BigInt(shCount * sh));
    let buildId: string | undefined, executable = false, notes = 0;
    const noteRegions = new Set<string>();
    function readNotes(offset: number, size: number) {
        const key = `${offset}:${size}`;
        if (noteRegions.has(key))
            return;
        noteRegions.add(key);
        const end = offset + size;
        while (offset < end) {
            if (end - offset < 12 || ++notes > 4096)
                throw invalid();
            const names = b.readUInt32LE(offset), bytes = b.readUInt32LE(offset + 4), type = b.readUInt32LE(offset + 8);
            const nameAt = offset + 12, dataAt = nameAt + Math.ceil(names / 4) * 4, next = dataAt + Math.ceil(bytes / 4) * 4;
            if (next > end)
                throw invalid();
            if (type === 3 && names === 4 && b.subarray(nameAt, nameAt + 4).equals(Buffer.from('GNU\0'))) {
                if (!bytes || bytes > 64)
                    throw invalid();
                const id = b.subarray(dataAt, dataAt + bytes).toString('hex');
                if (buildId && buildId !== id)
                    throw new Error('conflicting_elf_build_id');
                buildId = id;
            }
            offset = next;
        }
    }
    for (let i = 0; i < phCount; i++) {
        const at = phOffset + i * ph, type = b.readUInt32LE(at), flags = b.readUInt32LE(at + (wide ? 4 : 24));
        const [off, size] = range(word(at + (wide ? 8 : 4)), word(at + (wide ? 32 : 16)));
        const virtual = word(at + (wide ? 16 : 8)), memory = word(at + (wide ? 40 : 20)), align = word(at + (wide ? 48 : 28));
        if (align > 1n && (align & (align - 1n)) !== 0n)
            throw invalid();
        if (type === 1) {
            if (BigInt(size) > memory || virtual + memory > (1n << BigInt(wide ? 64 : 32)) || (align > 1n && virtual % align !== BigInt(off) % align))
                throw invalid();
            if ((flags & 1) && size > 0)
                executable = true;
        }
        if (type === 4)
            readNotes(off, size);
    }
    const sections: Array<{
        name: number;
        type: number;
        flags: bigint;
        off: number;
        size: number;
    }> = [];
    for (let i = 0; i < shCount; i++) {
        const at = shOffset + i * sh, type = b.readUInt32LE(at + 4), size = word(at + (wide ? 32 : 20));
        const [off, length] = type === 8 ? [0, 0] : range(word(at + (wide ? 24 : 16)), size);
        const item = { name: b.readUInt32LE(at), type, flags: word(at + 8), off, size: length };
        sections.push(item);
        if (type === 7)
            readNotes(off, length);
    }
    let info = false, line = false, unsupported = false;
    if (stringIndex) {
        const strings = sections[stringIndex]!;
        if (strings.type !== 3 || strings.size < 1 || strings.size > 1024 * 1024 || b[strings.off] !== 0)
            throw invalid();
        const names = b.subarray(strings.off, strings.off + strings.size), seen = new Set<string>();
        for (const section of sections) {
            if (section.name >= names.length)
                throw invalid();
            const end = names.indexOf(0, section.name);
            if (end < 0 || end - section.name > 256)
                throw invalid();
            const name = names.subarray(section.name, end).toString('ascii');
            if (name === '.debug_info' || name === '.debug_line') {
                if (seen.has(name))
                    throw invalid();
                seen.add(name);
                if (section.flags & 0x800n)
                    unsupported = true;
                if (section.type === 1 && section.size > 0) {
                    if (name === '.debug_info')
                        info = true;
                    else
                        line = true;
                }
            }
            if (name === '.zdebug_info' || name === '.zdebug_line' || name === '.debug_info.dwo' || name === '.debug_line.dwo' || name === '.gnu_debugaltlink')
                unsupported = true;
        }
    }
    if (!executable || !buildId)
        throw invalid();
    return { image: { buildId, abi }, hasDebugInfo: info && line && !unsupported };
}
