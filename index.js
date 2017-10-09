const fs = require('fs');

const ELFCLASS_32 = 1;
const ELFCLASS_64 = 2;

Array.prototype.pick = function(f) {
	for(let i = 0; i < this.length; i++) {
		if(f(this[i], i, this)) return i;
	}
	return -1;
}

class Prefix {
	constructor(mne) {
		this.mne = mne;
	}
}

class SegmentOverridePrefix extends Prefix {
	constructor(mne, segment) {
		super(mne);
		this.segment = segment;
	}
}

const prefixes = {
	0xF0: new Prefix('LOCK'),
	0xF3: new Prefix('REP'),
	0xF2: new Prefix('REPNE'),
	0x2E: new SegmentOverridePrefix('CS', 'CS'),
	0x36: new SegmentOverridePrefix('SS', 'SS'),
	0x3E: new SegmentOverridePrefix('DS', 'DS'),
	0x26: new SegmentOverridePrefix('ES', 'ES'),
	0x64: new SegmentOverridePrefix('FS', 'FS'),
	0x65: new SegmentOverridePrefix('GS', 'GS'),
	0x66: new Prefix('OO-16'),
	0x67: new Prefix('AO-16'),
};

let instructions = [];

const GPREG_32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const GPREG_16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const GPREG_8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const DBREG = ['dr0', 'dr1', 'dr2', 'dr3', 'dr4', 'dr5', 'dr6', 'dr7', 'dr8'];
const CTREG = ['cr0', 'cr1', 'cr2', 'cr3', 'cr4', 'cr5', 'cr6', 'cr7', 'cr8'];
let SEGREG = ['cs', 'ds', 'ss', 'es', 'fs', 'gs'];
const allRegs = GPREG_32.concat(GPREG_16, GPREG_8, DBREG, CTREG, SEGREG);

function decodeOp(elf, buf, index) {
	let addrLen = elf.header.cls == ELFCLASS_32 ? 32 : 64;
	let lpr = [];
	let op;
	while((op = buf[index++]) in prefixes) {
		lpr.push(op);
	}
	if(lpr.includes(0x66)) addrLen = 16;
	let isDouble = false;
	if(op == 0x0F) {
		isDouble = true;
		op = buf[index++];
	}
	let d = (op >> 1) & 0x01;
	let w = op & 0x01;
	//TODO: weird ALU stuff with secondary op
	let reg = null;
	let ins = instructions.pick(v => {
		if(v.prefix != null && !lpr.includes(v.prefix)) {
			return false;
		}
		if(isDouble == (v.dopc == '0F')) {
			if(op >> 3 == v.opc >> 3) {
				let ops = [];
				ops.push(v.op1);
				ops.push(v.op2);
				ops.push(v.op3);
				ops.push(v.op4);
				for(let i = 0; i < ops.length; i++) {
					if(ops[i].startsWith('Z')) {
						let regs = addrLen == 32 ? GPREG_32 : GPREG_16;
						if(w == 0) regs = GPREG_8;
						reg = new OpcodeArgRegister(regs[op & 0x7]);
						return true;
					}
				}
				return op == v.opc;
			}else if(op == v.opc) return true;
		}
		return false;
	});
	if(ins < 0) {
		console.log("Invalid opcode: " + (isDouble ? 'double ' : '') + op);
		return {index, dbl: isDouble, opcode: op};
	}
	ins = instructions[ins];
	let ops = [];
	ops.push(ins.op1);
	ops.push(ins.op2);
	ops.push(ins.op3);
	ops.push(ins.op4);
	let modRM = ins.rop;
	let preModIndex = index;
	let modRMData;
	if(modRM != null && modRM.length > 0) {
		modRMData = buf[index++];
		modRMData = {mod: modRMData >> 6, rm: modRMData & 0x7, reg: (modRMData >> 3) & 0x7};
	}
	let disp = 0;
	let rmr = '';
	if(reg == null && modRMData != null) {
		if(addrLen == 16) {
			let regs = w == 1 ? GPREG_16 : GPREG_8;
			if(modRM == 'r') reg = regs[modRMData.reg];
			const r16s = [['BX', 'SI'], ['BX', 'DI'], ['BP', 'SI'], ['BP', 'DI'], 'SI', 'DI', 'BP', 'BX'];
			rmr = r16s[modRMData.rm];
			if(modRMData.mod == 0) {
				if(rmr == 6) {
					rmr = buf.readInt16LE(index);
					index += 2;
					rmr = new OpcodeArgPtr(rmr, 'ds', w == 1 ? 2 : 1);
				}else if(Array.isArray(rmr)){
					rmr = new OpcodeArg16RegisterPtr(rmr[0], rmr[1], 0, w == 1 ? 2 : 1, null);
				}else{
					rmr = new OpcodeArgRegisterPtr(rmr[0], 0, w == 1 ? 2 : 1, null);
				}
				//rmr = `${w == 1 ? 'WORD PTR ' : 'BYTE PTR '}[${rmr}]`;
			}else if(modRMData.mod == 1) {
				let off = buf.readUInt8(index);
				index++;
				if(Array.isArray(rmr)){
					rmr = new OpcodeArg16RegisterPtr(rmr[0], rmr[1], off, 1, null);
				}else{
					rmr = new OpcodeArgRegisterPtr(rmr[0], off, w == 1 ? 2 : 1, null);
				}
				//rmr = `${w == 1 ? 'WORD PTR ' : 'BYTE PTR '}[${rmr}]`;
			}else if(modRMData.mod == 2) {
				let off =  buf.readUInt16LE(index);
				index += 2;
				if(Array.isArray(rmr)){
					rmr = new OpcodeArg16RegisterPtr(rmr[0], rmr[1], off, w == 1 ? 2 : 1, null);
				}else{
					rmr = new OpcodeArgRegisterPtr(rmr[0], off, w == 1 ? 2 : 1, null);
				}
				//rmr = `${w == 1 ? 'WORD PTR ' : 'BYTE PTR '}[${rmr}]`;
			}else if(modRMData.mod == 3) {
				rmr = new OpcodeArgRegister(regs[modRMData.rm]);
			}
		}else {
			let regs = w == 1 ? GPREG_32 : GPREG_8;
			if(modRM == 'r') reg = new OpcodeArgRegister(regs[modRMData.reg]);
			let sib;
			let hasSib = false;
			if(modRMData.rm == 4 && modRMData.mod != 3) {
				hasSib = true;
				sib = buf.readUInt8(index);
				index++;
				let scale = sib >> 6;
				let sin = (sib >> 3) & 0x07;
				let base = sib & 0x07;
				if(modRMData.mod == 0) {
					if(sin == 4) {
						if(base == 5) {
							sib = new OpcodeArgPtr(buf.readInt32LE(index), 'ds', w == 1 ? 4 : 1);
							index += 4;
						}else{
							sib = new OpcodeArgRegister(GPREG_32[base]);
						}
					}else{
						sib = new OpcodeArgSIB((Math.pow(2, scale) | 0), GPREG_32[sin], GPREG_32[base]);
					}
				}else if(modRMData.mod == 1 || modRMData.mod == 2) {
					if(sin == 4) {
						sib = new OpcodeArgRegister(GPREG_32[base]);
					}else{
						sib = new OpcodeArgSIB((Math.pow(2, scale) | 0), GPREG_32[sin], GPREG_32[base]);
					}
				}
			}
			if(modRMData.mod == 0) {
				if(modRMData.rm == 4) {
					rmr = sib;
				}else if(modRMData.rm == 5) {
					rmr = new OpcodeArgPtr(buf.readInt32LE(index), 'ds', w == 1 ? 4 : 1);
					index += 4;
				}else {
					rmr = new OpcodeArgRegisterPtr(GPREG_32[modRMData.rm], 0, w == 1 ? 4 : 1, null);
				}
			}else if(modRMData.mod == 1) {
				rmr = buf.readInt8(index);
				index++;
				if(hasSib) {
					sib.offset = rmr;
					rmr = sib;
				}else{
					rmr = new OpcodeArgRegisterPtr(GPREG_32[modRMData.rm], rmr, w == 1 ? 4 : 1, null);
				}
			}else if(modRMData.mod == 2) {
				rmr = buf.readInt32LE(index);
				index += 4;
				if(hasSib) {
					sib.offset = rmr;
					rmr = sib;
				}else{
					rmr = new OpcodeArgRegisterPtr(GPREG_32[modRMData.rm], rmr, w == 1 ? 4 : 1, null);
				}
			}else if(modRMData.mod == 3) {
				rmr = new OpcodeArgRegister(regs[modRMData.rm]);
			}
		}
	}
	let rets = [];
	if(modRMData != null) {
		if(modRM != 'r') {
			rets = [rmr];
			ins = instructions.pick(v => {
				if(v.prefix != null && !lpr.includes(v.prefix)) {
					return false;
				}
				if(isDouble == (v.dopc == '0F') && op == v.opc && parseInt(v.rop, 10) == modRMData.reg) return true;
				return false;
			});
			if(ins < 0) {
				index = preModIndex;
				console.log("Invalid opcode: " + (isDouble ? 'double ' : '') + op);
				return {index, dbl: isDouble, opcode: op, subOpcode: modRMData.reg};
			}
			ins = instructions[ins];
			ops = [];
			ops.push(ins.op1);
			ops.push(ins.op2);
			ops.push(ins.op3);
			ops.push(ins.op4);
		}else if(d == 0) rets = [rmr, reg];
		else rets = [reg, rmr];
	}else if(reg != null) {
		rets = [reg];
	}
	for(let i = 0; i < ops.length; i++) {
		if(ops[i] == null) {
			if(i in rets) delete rets[i];
			continue;
		}
		if(ops[i] == 'Ib' || ops[i] == 'Jb') {
			rets[i] = new OpcodeArgImmediate(buf.readUInt8(index++));
		}else if(ops[i] == 'Ibs' || ops[i] == 'Jbs') {
			rets[i] = new OpcodeArgImmediate(buf.readInt8(index++));
		}else if(ops[i] == 'Iw' || ops[i] == 'Jw') {
			rets[i] = new OpcodeArgImmediate(buf.readUInt16LE(index));
			index += 2;
		}else if(ops[i] == 'Iws' || ops[i] == 'Jws') {
			rets[i] = new OpcodeArgImmediate(buf.readInt16LE(index));
			index += 2;
		}else if(ops[i] == 'Iv' || ops[i] == 'Jv') { // 64-bit ones??
			rets[i] = new OpcodeArgImmediate(buf.readUInt32LE(index));
			index += 4;
		}else if(ops[i] == 'Ivs' || ops[i] == 'Jvs') { // 64-bit ones??
			rets[i] = new OpcodeArgImmediate(buf.readInt32LE(index));
			index += 4;
		}else if(allRegs.includes(ops[i].toLowerCase())) {
			rets[i] = new OpcodeArgRegister(ops[i].toLowerCase());
		}else if(ops[i] == 'Yb') {
			rets[i] = new OpcodeArgRegisterPtr('edi', 0, 1, 'es');
		}else if(ops[i] == 'Yw') {
			rets[i] = new OpcodeArgRegisterPtr('edi', 0, 2, 'es');
		}else if(ops[i] == 'Yv') {
			rets[i] = new OpcodeArgRegisterPtr('edi', 0, 4, 'es');
		}
	}
	let po = null;
	for(let pf of lpr) {
		if(pf in prefixes && prefixes[pf] instanceof SegmentOverridePrefix) {
			po = prefixes[pf].segment;
		}
	}
	if(po != null)
		for(let i = 0; i < rets.length; i++) {
			if('segment' in rets[i]) {
				rets[i].segment = po;
			}
		}
	return {index, reg, rm: rmr, rets, ins};
}

const PTR_SIZE = [null, 'BYTE', 'WORD', null, 'DWORD', null, null, null, 'QWORD'];

class OpcodeArg {
	constructor() {

	}
}

class OpcodeArgRegister extends OpcodeArg {
	constructor(reg) {
		super();
		this.reg = reg;
	}

	toString() {
		return this.reg;
	}
}

class OpcodeArgImmediate extends OpcodeArg {
	constructor(value) {
		super();
		this.value = value;
	}

	toString() {
		return '0x' + this.value.toString(16);
	}
}

class OpcodeArgPtr extends OpcodeArg {
	constructor(offset, segment, size) {
		super();
		this.offset = offset;
		this.segment = segment;
		this.size = size;
	}

	toString() {
		return `${PTR_SIZE[this.size]} PTR ${this.segment == null ? '' : this.segment.toLowerCase() + ':'}[0x${this.offset.toString(16)}]`;
	}
}

class OpcodeArg16RegisterPtr extends OpcodeArgRegister {
	constructor(reg, reg2, offset, size, segment) {
		super(reg);
		this.reg2 = reg;
		this.offset = offset;
		this.size = size;
		this.segment = segment;
	}

	toString() {
		return `${PTR_SIZE[this.size]} PTR ${this.segment == null ? '' : this.segment.toLowerCase() + ':'}[${this.reg} + ${this.reg2}${this.offset > 0 ? ' + 0x' + this.offset.toString(16) : ''}]`;
	}
}

class OpcodeArgRegisterPtr extends OpcodeArgRegister {
	constructor(reg, offset, size, segment) {
		super(reg);
		this.offset = offset;
		this.size = size;
		this.segment = segment;
	}

	toString() {
		return `${PTR_SIZE[this.size]} PTR ${this.segment == null ? '' : this.segment.toLowerCase() + ':'}[${this.reg}${this.offset > 0 ? ' + 0x' + this.offset.toString(16) : ''}]`;
	}
}

class OpcodeArgSIB extends OpcodeArg {
	constructor(scale, index, base, offset) {
		super();
		this.offset = offset;
		this.scale = scale;
		this.index = index;
		this.base = base;
	}

	toString() {
		return `${PTR_SIZE[4]} PTR ${this.segment == null ? '' : this.segment.toLowerCase() + ':'}[${this.base} + ${this.index} * ${this.scale}${this.offset > 0 ? ' + 0x' + this.offset.toString(16) : ''}]`;
	}
}

class Opcode {
	constructor(index, length, prefixes, ins, args) {
		this.index = index;
		this.length = length;
		this.prefixes = prefixes;
		this.ins = ins;
		this.args = args;
	}
}

class Instruction {
	constructor(mne, op1, op2, op3, op4, prefix, opc, opc2, fields, rop, lock, ext) {
		this.mne = mne;
		this.op1 = op1;
		this.op2 = op2;
		this.op3 = op3;
		this.op4 = op4;
		this.prefix = prefix;
		this.opc = op;
		this.opc2 = opc2;
		this.fields = fields;
		this.rop = rop;
		this.lock = lock;
		this.ext = ext;
	}
}

{
	let rins = JSON.parse(fs.readFileSync('instructions.json', 'utf8'));
	for(let ins of rins) {
		ins.prefix = ins.prefix.length == 0 ? null : parseInt(ins.prefix, 16);
		ins.opc = ins.opc.length == 0 ? null : parseInt(ins.opc, 16);
		ins.opc2 = ins.opc2.length == 0 ? null : parseInt(ins.opc2, 16);
		instructions.push(ins);
	}
}

class UInt64 {
	constructor(buf) {
		this.buf = buf;
	}

	toString() {
		return `0x${this.buf.toString('hex')}`;
	}

	static fromString(str) {
		if(!str.startsWith('0x') || str.length != 18) return null;
		return new UInt64(Buffer.from(str.substring(2), 'hex'));
	}

	equals(other) {
		return this.buf.equals(other.buf);
	}
}

Buffer.prototype.readUInt64LE = function(offset) {
	return new UInt64(this.slice(offset, offset + 8));
}

Buffer.prototype.writeUInt64LE = function(value, offset) {
	this.writeUInt32LE(value.buf.readUInt32LE(0), offset);
	this.writeUInt32LE(value.buf.readUInt32LE(4), offset + 4);
}

function scanObjectTypes(obj) {
	let x;
	for(let key in obj) {
		if(typeof obj[key] == 'string' && (x = UInt64.fromString(obj[key])) != null) {
			obj[key] = x;
		}
	}
}

class ElfFile {
	constructor(buf) {
		if(arguments.length == 0) return;
		else if(arguments.length == 1) {
			this.header = new ElfFileHeader(buf.slice(4));
			let p = this.header.programHeader;
			this.programs = [];
			for(let i = 0; i < this.header.programHeaderCount; i++) {
				let prgm = new ElfProgramHeader(this, buf.slice(p, p + this.header.programHeaderSize));
				prgm.read(buf);
				this.programs.push(prgm);
				p += this.header.programHeaderSize;
			}
			p = this.header.sectionHeader;
			this.sections = [];
			for(let i = 0; i < this.header.sectionHeaderCount; i++) {
				let sec = new ElfSectionHeader(this, buf.slice(p, p + this.header.sectionHeaderSize));
				sec.read(buf);
				if(sec.type == 1) {
					sec.disassemble(this);
				}
				this.sections.push(sec);
				p += this.header.sectionHeaderSize;
			}
		}else {
			this.header = header;
			this.programs = programs;
			this.sections = sections;
		}
	}

	serialize() {
		let maxI = 0;
		for(let prog of this.programs) {
			if(prog.offset + prog.size > maxI) maxI = prog.offset + prog.size;
		}
		for(let sec of this.sections) {
			if(sec.offset + sec.size > maxI) maxI = sec.offset + sec.size;
		}
		if((this.header.sectionHeader + this.header.sectionHeaderSize * this.header.sectionHeaderCount) > maxI) maxI = this.header.sectionHeader + (this.header.sectionHeaderSize * this.header.sectionHeaderCount);
		if((this.header.programHeader + this.header.programHeaderSize * this.header.programHeaderCount) > maxI) maxI = this.header.programHeader + (this.header.programHeaderSize * this.header.programHeaderCount);
		let buf = Buffer.alloc(maxI);
		new Buffer([ 0x7F, 0x45, 0x4C, 0x46 ]).copy(buf, 0);
		this.header.serialize(this).copy(buf, 4);
		for(let i = 0; i < this.programs.length; i++) {
			this.programs[i].serialize(this).copy(buf, this.header.programHeader + (i * this.header.programHeaderSize));
			this.programs[i].rawData.copy(buf, this.programs[i].offset);
		}
		for(let i = 0; i < this.sections.length; i++) {
			this.sections[i].serialize(this).copy(buf, this.header.sectionHeader + (i * this.header.sectionHeaderSize));
			this.sections[i].rawData.copy(buf, this.sections[i].offset);
		}
		return buf;
	}

	save() {
		fs.writeFileSync('file_header.json', JSON.stringify(this.header, (key, value) => {
			if(key == 'programs' || key == 'sections') return undefined;
			if(key == 'pad') return value.toString();
			return value;
		}, 4));
		fs.writeFileSync('sections.json', JSON.stringify(this.sections, (key, value) => {
			if(key == 'rawData' || key == 'asm') return undefined;
			return value;
		}, 4));
		fs.writeFileSync('programs.json', JSON.stringify(this.programs, (key, value) => {
			if(key == 'rawData') return undefined;
			return value;
		}, 4));
		try{
			fs.mkdirSync('programs_raw');
			fs.mkdirSync('sections_raw');
			fs.mkdirSync('sections_asm');
		}catch(e) {

		}
		for(let i = 0; i < this.sections.length; i++) {
			fs.writeFileSync('sections_raw/' + this.sections[i].offset + '', this.sections[i].rawData);
			if('asm' in this.sections[i]) {
				fs.writeFileSync('sections_asm/' + this.sections[i].offset + '', this.sections[i].asm.map(v => v.join(', ').replace(',', '')).join('\n'));
			}
		}
		for(let i = 0; i < this.programs.length; i++) {
			fs.writeFileSync('programs_raw/' + this.programs[i].offset + '', this.programs[i].rawData);
		}
	}

	static load() {
		let ef = new ElfFile();
		ef.header = JSON.parse(fs.readFileSync('file_header.json', 'utf8'));
		scanObjectTypes(ef.header);
		Object.setPrototypeOf(ef.header, ElfFileHeader.prototype);
		ef.sections = JSON.parse(fs.readFileSync('sections.json', 'utf8'));
		ef.programs = JSON.parse(fs.readFileSync('programs.json', 'utf8'));
		for(let i = 0; i < ef.sections.length; i++) {
			scanObjectTypes(ef.sections[i]);
			Object.setPrototypeOf(ef.sections[i], ElfSectionHeader.prototype);
			ef.sections[i].rawData = fs.readFileSync('sections_raw/' + ef.sections[i].offset + '.json');
		}
		for(let i = 0; i < ef.programs.length; i++) {
			scanObjectTypes(ef.programs[i]);
			Object.setPrototypeOf(ef.programs[i], ElfProgramHeader.prototype);
			ef.programs[i].rawData = fs.readFileSync('programs_raw/' + ef.programs[i].offset + '.json');
		}
		return ef;
	}
}

class ElfFileHeader {
	constructor(buf) {
		if(arguments.length == 0) return;
		else if (arguments.length == 1) {
			this.cls = buf.readUInt8(0);
			this.endianness = buf.readUInt8(1);
			this.version = buf.readUInt8(2);
			this.os = buf.readUInt8(3);
			this.pad = buf.readUInt64LE(4);
			this.type = buf.readUInt16LE(12);
			this.architecture = buf.readUInt16LE(14);
			this.version2 = buf.readUInt32LE(16);
			this.entrypoint = this.cls == ELFCLASS_32 ? buf.readUInt32LE(20) : buf.readUInt64LE(20);
			this.programHeader = this.cls == ELFCLASS_32 ? buf.readUInt32LE(24) : buf.readUInt64LE(28);
			this.sectionHeader = this.cls == ELFCLASS_32 ? buf.readUInt32LE(28) : buf.readUInt64LE(36);
			this.flags = buf.readUInt32LE(this.cls == ELFCLASS_32 ? 32 : 44);
			this.headerSize = buf.readUInt16LE(this.cls == ELFCLASS_32 ? 36 : 48);
			this.programHeaderSize = buf.readUInt16LE(this.cls == ELFCLASS_32 ? 38 : 50);
			this.programHeaderCount = buf.readUInt16LE(this.cls == ELFCLASS_32 ? 40 : 52);
			this.sectionHeaderSize = buf.readUInt16LE(this.cls == ELFCLASS_32 ? 42 : 54);
			this.sectionHeaderCount = buf.readUInt16LE(this.cls == ELFCLASS_32 ? 44 : 56);
			this.sectionHeaderNames = buf.readUInt16LE(this.cls == ELFCLASS_32 ? 46 : 58);
		}else{
			this.cls = arguments[0];
			this.endianness = arguments[1];
			this.version = arguments[2];
			this.os = arguments[3];
			this.pad = arguments[4];
			this.type = arguments[5];
			this.architecture = arguments[6];
			this.version2 = arguments[7];
			this.entrypoint = arguments[8];
			this.programHeader = arguments[9];
			this.sectionHeader = arguments[10];
			this.flags = arguments[11];
			this.headerSize = arguments[12];
			this.programHeaderSize = arguments[13];
			this.programHeaderCount = arguments[14];
			this.sectionHeaderSize = arguments[15];
			this.sectionHeaderCount = arguments[16];
			this.sectionHeaderNames = arguments[17];
		}
	}

	serialize(elf) {
		let buf = Buffer.alloc(elf.header.cls == ELFCLASS_32 ? 48 : 60);
		buf.writeUInt8(this.cls, 0);
		buf.writeUInt8(this.endianness, 1);
		buf.writeUInt8(this.version, 2);
		buf.writeUInt8(this.os, 3);
		buf.writeUInt64LE(this.pad, 4);
		buf.writeUInt16LE(this.type, 12);
		buf.writeUInt16LE(this.architecture, 14);
		buf.writeUInt32LE(this.version2, 16);
		if(elf.header.cls == ELFCLASS_32) {
			buf.writeUInt32LE(this.entrypoint, 20);
			buf.writeUInt32LE(this.programHeader, 24);
			buf.writeUInt32LE(this.sectionHeader, 28);
			buf.writeUInt32LE(this.flags, 32);
			buf.writeUInt16LE(this.headerSize, 36);
			buf.writeUInt16LE(this.programHeaderSize, 38);
			buf.writeUInt16LE(this.programHeaderCount, 40);
			buf.writeUInt16LE(this.sectionHeaderSize, 42);
			buf.writeUInt16LE(this.sectionHeaderCount, 44);
			buf.writeUInt16LE(this.sectionHeaderNames, 46);
		}else{
			buf.writeUInt64LE(this.entrypoint, 20);
			buf.writeUInt64LE(this.programHeader, 28);
			buf.writeUInt64LE(this.sectionHeader, 36);
			buf.writeUInt32LE(this.flags, 44);
			buf.writeUInt16LE(this.headerSize, 48);
			buf.writeUInt16LE(this.programHeaderSize, 50);
			buf.writeUInt16LE(this.programHeaderCount, 52);
			buf.writeUInt16LE(this.sectionHeaderSize, 54);
			buf.writeUInt16LE(this.sectionHeaderCount, 56);
			buf.writeUInt16LE(this.sectionHeaderNames, 58);
		}
		return buf;
	}
}

class ElfProgramHeader {
	constructor(elf, buf) {
		if(arguments.length == 2) {
			this.type = buf.readUInt32LE(0);
			this.flags = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(24) : buf.readUInt32LE(4);
			this.offset = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(4) : buf.readUInt64LE(8);
			this.memAddr = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(8) : buf.readUInt64LE(16);
			this.memAddrPhysical = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(12) : buf.readUInt64LE(24);
			this.size = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(16) : buf.readUInt64LE(32);
			this.memSize = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(20) : buf.readUInt64LE(40);
			this.alignment = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(28) : buf.readUInt64LE(48);
		}else if(arguments.length == 8) {
			this.type = arguments[0];
			this.flags = arguments[1];
			this.offset = arguments[2];
			this.memAddr = arguments[3];
			this.memAddrPhysical = arguments[4];
			this.size = arguments[5];
			this.memSize = arguments[6];
			this.alignment = arguments[7];
		}
	}

	read(buf) {
		this.rawData = buf.slice(this.offset, this.offset + this.size);
	}

	serialize(elf) {
		let buf = Buffer.alloc(elf.header.cls == ELFCLASS_32 ? 32 : 56);
		buf.writeUInt32LE(this.type, 0);
		buf.writeUInt32LE(this.flags, elf.header.cls == ELFCLASS_32 ? 24 : 4);
		if(elf.header.cls == ELFCLASS_32) {
			buf.writeUInt32LE(this.offset, 4);
			buf.writeUInt32LE(this.memAddr, 8);
			buf.writeUInt32LE(this.memAddrPhysical, 12);
			buf.writeUInt32LE(this.size, 16);
			buf.writeUInt32LE(this.memSize, 20);
			buf.writeUInt32LE(this.alignment, 28);
		}else{
			buf.writeUInt64LE(this.offset, 8);
			buf.writeUInt64LE(this.memAddr, 16);
			buf.writeUInt64LE(this.memAddrPhysical, 24);
			buf.writeUInt64LE(this.size, 32);
			buf.writeUInt64LE(this.memSize, 40);
			buf.writeUInt64LE(this.alignment, 48);
		}
		return buf;
	}
}

class ElfSectionHeader {
	constructor(elf, buf) {
		if(arguments.length == 2) {
			this.name = buf.readUInt32LE(0);
			this.type = buf.readUInt32LE(4);
			this.flags = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(8) : buf.readUInt64LE(8);
			this.memAddr = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(12) : buf.readUInt64LE(16);
			this.offset = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(16) : buf.readUInt64LE(24);
			this.size = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(20) : buf.readUInt64LE(32);
			this.assoc = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(24) : buf.readUInt32LE(40);
			this.info = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(28) : buf.readUInt32LE(44);
			this.align = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(32) : buf.readUInt64LE(52);
			this.entsize = elf.header.cls == ELFCLASS_32 ? buf.readUInt32LE(36) : buf.readUInt64LE(60);
		}else if(arguments.length == 10) {
			this.name = arguments[0];
			this.type = arguments[1];
			this.flags = arguments[2];
			this.memAddr = arguments[3];
			this.offset = arguments[4];
			this.size = arguments[5];
			this.assoc = arguments[6];
			this.info = arguments[7];
			this.align = arguments[8];
			this.entsize = arguments[9];
		}
	}

	read(buf) {
		this.rawData = buf.slice(this.offset, this.offset + this.size);
	}

	serialize(elf) {
		let buf = Buffer.alloc(elf.header.cls == ELFCLASS_32 ? 40 : 68);
		buf.writeUInt32LE(this.name, 0);
		buf.writeUInt32LE(this.type, 4);
		if(elf.header.cls == ELFCLASS_32) {
			buf.writeUInt32LE(this.flags, 8);
			buf.writeUInt32LE(this.memAddr, 12);
			buf.writeUInt32LE(this.offset, 16);
			buf.writeUInt32LE(this.size, 20);
			buf.writeUInt32LE(this.assoc, 24);
			buf.writeUInt32LE(this.info, 28);
			buf.writeUInt32LE(this.align, 32);
			buf.writeUInt32LE(this.entsize, 36);
		}else{
			buf.writeUInt64LE(this.flags, 8);
			buf.writeUInt64LE(this.memAddr, 16);
			buf.writeUInt64LE(this.offset, 24);
			buf.writeUInt64LE(this.size, 32);
			buf.writeUInt32LE(this.assoc, 40);
			buf.writeUInt32LE(this.info, 44);
			buf.writeUInt64LE(this.align, 52);
			buf.writeUInt64LE(this.entsize, 60);
		}
		return buf;
	}

	disassemble(elf) {
		this.asm = [];
		try{
			for(let i = 0; i < this.size;) {
				let re = decodeOp(elf, this.rawData, i);
				if(re == null) break;
				i = re.index;
				if('ins' in re)
					this.asm.push([re.ins.mne, ...re.rets.map(v => v.toString())]);
				else 
					this.asm.push(['(bad opcode)', '0x' + (re.dbl ? '0F ' : '') + re.opcode.toString(16) + ('subOpcode' in re ? '/' + re.subOpcode : '')])
			}
		}catch(e) {
			console.log(e);
		}
	}
}

if(process.argv.length < 3) {
	console.log("Usage: node index.js <sub>...");
	process.exit();
}

let sub = process.argv[2];
if(sub == 'disassemble') {
	if(process.argv.length != 4) {
		console.log("Usage: node index.js disassemble <input ELF>");
		process.exit();
	}
	let file = fs.readFileSync(process.argv[3]);
	if(!file.slice(0, 4).equals(new Buffer([ 0x7F, 0x45, 0x4C, 0x46 ]))) {
		console.log('Not an ELF file!');
		process.exit();
	}
	let ef = new ElfFile(file);
	ef.save();
}else if(sub == 'assemble') {
	if(process.argv.length != 3) {
		console.log("Usage: node index.js assemble");
		process.exit();
	}
	let ef = ElfFile.load();
	fs.writeFileSync('out.elf', ef.serialize());
}else if(sub == 'f2m') {
	if(process.argv.length != 4) {
		console.log("Usage: node index.js f2m <file address>");
		process.exit();
	}
}else if(sub == 'm2f') {
	if(process.argv.length != 4) {
		console.log("Usage: node index.js m2f <memory address>");
		process.exit();
	}
}