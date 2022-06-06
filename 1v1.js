// ==UserScript==
// @name         Wasm Patcher
// @version      0.1
// @description  WebAssemblyのbufferにパッチを当てる
// @author       nekocell
// @namespace    https://greasyfork.org/ja/users/762895-nekocell
// ==/UserScript==

class BufferReader {
    constructor(buffer) {
        this._buffer = buffer.slice(0);

        this._pos = 0;
    }

    get finished() {
        return this._pos >= this._buffer.length;
    }

    get length() {
        return this._buffer.length;
    }

    reset() {
        this._pos = 0;
    }

    readU8() {
        return this._buffer[this._pos++];
    }

    readU32() {
        return this.readU8() |
            (this.readU8() << 8) |
            (this.readU8() << 16) |
            (this.readU8() << 24);
    }

    readVarU32() {
        let result = 0;
        let shift = 0;

        let currentByte;

        do {
            currentByte = this.readU8();
            result |= (currentByte & 0x7F) << shift;
            shift += 7;
        } while (currentByte & 0x80);

        return result;
    }

    readBytes(count) {
        const bytes = []

        for (let i = 0; i < count; i++) {
            bytes.push(this.readU8());
        }

        return bytes;
    }

    readBytesToEnd() {
        const bytes = []

        while (!this.finished) {
            bytes.push(this.readU8());
        }

        return bytes;
    }
}


class BufferBuilder {
    constructor() {
        this._buffer = new Uint8Array(100);
        this._pos = 0;
    }

    get length() {
        return this._pos;
    }

    _resizeBuffer() {
        if (this._pos >= this._buffer.length - 1) {
            let tmp = this._buffer;
            this._buffer = new Uint8Array(this._buffer.length * 2);
            this._buffer.set(tmp);
        }
    }

    pushU8(val) {
        this._resizeBuffer();

        this._buffer[this._pos++] = val;
    }

    pushU32(val) {
        this.pushU8(val & 0x000000ff);
        this.pushU8((val & 0x0000ff00) >> 8);
        this.pushU8((val & 0x00ff0000) >> 16);
        this.pushU8((val & 0xff000000) >> 24);
    }

    pushVarU32(val) {
        let byte = 0;
        let value = val;

        if (val == 0) {
            this.pushU8(0);
            return;
        }

        while (value > 0) {
            byte = value & 0x7F;
            value >>= 7;

            if (value !== 0) {
                byte |= 0x80;
            }

            this.pushU8(byte);
        }
    }

    pushBytes(bytes) {
        for (let i = 0; i < bytes.length; i++) {
            this.pushU8(bytes[i]);
        }
    }

    build() {
        return this._buffer.slice(0, this._pos);
    }
}

const Section = Object.freeze({
    Custom: 0x00,
    Type: 0x01,
    Import: 0x02,
    Function: 0x03,
    Table: 0x04,
    Memory: 0x05,
    Global: 0x06,
    Export: 0x07,
    Start: 0x08,
    Element: 0x09,
    Code: 0x0A,
    Data: 0x0B,
    DataCount: 0x0C,
});

const ValueType = Object.freeze({
    i32: 0x7F,
    i64: 0x7E,
    f32: 0x7D,
    f64: 0x7C
});

const SignatureType = Object.freeze({
    func: 0x60
});

const ExternalKind = Object.freeze({
    Function: 0x00,
    Table: 0x01,
    Memory: 0x02,
    Global: 0x03
});

const OP = Object.freeze({
    unreachable: 0x00,
    nop: 0x01,
    block: 0x02,
    loop: 0x02,
    if: [0x04, 0x40],
    else: 0x05,
    end: 0x0B,
    return: 0x0F,
    drop: 0x1A,
    local: {
        get: 0x20,
        set: 0x21,
    },
    global: {
        get: 0x23,
        set: 0x24,
    },
    i32: {
        load: 0x28,
        store: 0x36,
        const: 0x41,
        eq: 0x46,
        add: 0x6A,
        sub: 0x6B,
        mul: 0x6C,
    },
    i64: {
        load: 0x29,
        store: 0x37,
        const: 0x41,
    },
    f32: {
        load: 0x2A,
        store: 0x38,
        const: 0x43,
        mul: 0x94,
    },
    f64: {
        load: 0x2B,
        store: 0x39,
        const: 0x44,
    },
});

const VAR = Object.freeze({
    u32: (val) => {
        const result = [];
        let value = val;

        if (val === 0) {
            return [0];
        }

        while (value > 0) {
            const byte = value & 0x7F;
            value >>= 7;

            if (value !== 0) {
                byte |= 0x80;
            }

            result.push(byte);
        }

        return result;
    },
    s32: (value) => {
        const result = [];

        while (true) {
            const byte = value & 0x7f;
            value >>= 7;

            if ((value === 0 && (byte & 0x40) === 0) ||
                (value === -1 && (byte & 0x40) !== 0)
            ) {
                result.push(byte);

                return result;
            }

            result.push(byte | 0x80);
        }
    },
    f32: (value) => {
        const f32ary = new Float32Array([value]);
        const f32bytes = new Uint8Array(f32ary.buffer);
        return [...f32bytes];
    },
    f64: (value) => {
        const f64ary = new Float64Array([value]);
        const f64bytes = new Uint8Array(f64ary.buffer);
        return [...f64bytes];
    }
});

class WasmIndex {
    constructor(index) {
        this._index = index;
    }
}

class WasmPatcher {
    constructor(wasmBuffer) {
        this._oldWasm = new BufferReader(new Uint8Array(wasmBuffer));
        this._newWasm = new BufferBuilder();

        this._importFunctionCount = 0;
        this._importGlobalCount = 0;

        this._aobPatchEntries = [];
        this._aobPatchFinished = false;

        this._addFunctionEntries = [];

        this._addGlobalVariableEntries = [];
    }

    _string2bytes(string) {
        let bytes = [];

        for (let i = 0; i < string.length; i++) {
            let code = string.charCodeAt(i);
            bytes.push(code);
        }

        return bytes;
    }

    _string2type(string) {
        switch (string) {
            case 's32':
            case 'u32':
            case 'i32': return ValueType.i32;
            case 's64':
            case 'u64':
            case 'i64': return ValueType.i64;
            case 'f32': return ValueType.f32;
            case 'f64': return ValueType.f64;
            default: throw new Error("Invalid string");
        }
    }

    _createInstantiationTimeInitializer(typeString, value) {
        switch (typeString) {
            case 'u32': return [OP.i32.const, ...VAR.u32(value), OP.end];
            case 's32': return [OP.i32.const, ...VAR.s32(value), OP.end];
            //case 'i64': return ValueType.i64;
            case 'f32': return [OP.f32.const, ...VAR.f32(value), OP.end];
            case 'f64': return [OP.f64.const, ...VAR.f64(value), OP.end];
            default: throw new Error("Invalid string");
        }
    }

    _parseTypeSection() {
        const sectionLen = this._oldWasm.readVarU32();
        const sectionBody = this._oldWasm.readBytes(sectionLen);

        const oldSection = new BufferReader(sectionBody);
        const newSection = new BufferBuilder();

        //TODO 既存のTypeIndexと紐付け　なかったらついか
        // がいいけどめんどいから　追加だけ

        const addFunctionEntries = this._addFunctionEntries;

        const oldTypeCount = oldSection.readVarU32();
        const newTypeCount = oldTypeCount + addFunctionEntries.length;

        newSection.pushVarU32(newTypeCount);

        for (let i = 0; i < oldTypeCount; ++i) {
            const form = oldSection.readU8();
            const paramCount = oldSection.readVarU32();
            let params = [];

            for (let j = 0; j < paramCount; ++j) {
                const param = oldSection.readU8();
                params.push(param);
            }

            const returnCount = oldSection.readU8();
            let returnType;

            newSection.pushU8(form);
            newSection.pushVarU32(paramCount);
            newSection.pushBytes(params);
            newSection.pushU8(returnCount);

            if (returnCount === 1) {
                returnType = oldSection.readU8();
                newSection.pushU8(returnType);
            }
        }

        for (let i = 0; i < addFunctionEntries.length; ++i) {
            const entry = addFunctionEntries[i];

            const form = SignatureType.func;
            const params = entry.params;

            newSection.pushU8(form);
            newSection.pushVarU32(params.length);
            newSection.pushBytes(params);

            let returnType = entry.return;

            if (returnType) {
                newSection.pushU8(1);
                newSection.pushU8(returnType);
            }
            else {
                newSection.pushU8(0);
            }

            entry._typeIndex = i + oldTypeCount;
        }

        this._newWasm.pushVarU32(newSection.length);
        this._newWasm.pushBytes(newSection.build());
    }

    _parseImportSection() {
        const sectionLen = this._oldWasm.readVarU32();
        const sectionBody = this._oldWasm.readBytes(sectionLen);

        const oldSection = new BufferReader(sectionBody);
        const newSection = new BufferBuilder();

        const addFunctionEntries = this._addFunctionEntries;

        const importCount = oldSection.readVarU32();

        newSection.pushVarU32(importCount);

        for (let i = 0; i < importCount; ++i) {
            const moduleNameLen = oldSection.readVarU32();
            const moduleName = oldSection.readBytes(moduleNameLen);
            const exportNameLen = oldSection.readVarU32();
            const exportName = oldSection.readBytes(exportNameLen);

            newSection.pushVarU32(moduleNameLen);
            newSection.pushBytes(moduleName);
            newSection.pushVarU32(exportNameLen);
            newSection.pushBytes(exportName);

            const kind = oldSection.readU8();

            newSection.pushU8(kind);

            switch (kind) {
                case ExternalKind.Function:
                    this._importFunctionCount++;

                    const typeIndex = oldSection.readVarU32();
                    newSection.pushVarU32(typeIndex);
                    break;
                case ExternalKind.Table:
                    const elementType = oldSection.readU8();
                    const resizableFlags = oldSection.readU8();
                    const resizableMinimum = oldSection.readVarU32();

                    newSection.pushU8(elementType);
                    newSection.pushU8(resizableFlags);
                    newSection.pushVarU32(resizableMinimum);

                    if (resizableFlags) {
                        const resizableMaximum = oldSection.readVarU32();
                        newSection.pushVarU32(resizableMaximum);
                    }
                    break;
                case ExternalKind.Memory:
                    const limitsFlags = oldSection.readU8();
                    const limitsMinimum = oldSection.readVarU32();

                    newSection.pushU8(limitsFlags);
                    newSection.pushVarU32(limitsMinimum);

                    if (limitsFlags) {
                        const limitsMaximum = oldSection.readVarU32();
                        newSection.pushVarU32(limitsMinimum);
                    }
                    break;
                case ExternalKind.Global:
                    this._importGlobalCount++;

                    const variableType = oldSection.readU8();
                    const variableMutability = oldSection.readU8();

                    newSection.pushU8(variableType);
                    newSection.pushU8(variableMutability);
                    break;
                default:
                    throw new Error("Invalid Import kind");
            }
        }

        this._newWasm.pushVarU32(newSection.length);
        this._newWasm.pushBytes(newSection.build());
    }

    _readInstantiationTimeInitializer(reader, builder) {
        let byte;
        while ((byte = reader.readU8()) !== OP.end) {
            builder.pushU8(byte);

            switch (byte) {
                case OP.i32.const:
                case OP.i64.const: {
                    const value = reader.readVarU32();
                    builder.pushVarU32(value);
                    break;
                }
                case OP.f32.const: {
                    const valueBytes = reader.readBytes(4);
                    builder.pushVarU32(valueBytes);
                    break;
                }
                case OP.f64.const: {
                    const valueBytes = reader.readBytes(8);
                    builder.pushVarU32(valueBytes);
                    break;
                }
                case OP.global.get: {
                    const index = reader.readVarU32();
                    builder.pushVarU32(index);
                    break;
                }
                default:
                    throw new Error("Invalid byte");
            }
        }

        builder.pushU8(OP.end);
    }

    _parseGlobalSection() {
        const sectionLen = this._oldWasm.readVarU32();
        const sectionBody = this._oldWasm.readBytes(sectionLen);

        const oldSection = new BufferReader(sectionBody);
        const newSection = new BufferBuilder();

        const addGlobalVariableEntries = this._addGlobalVariableEntries;

        const oldGlobalCount = oldSection.readVarU32();
        const newGlobalCount = oldGlobalCount + addGlobalVariableEntries.length;

        newSection.pushVarU32(newGlobalCount);

        for (let i = 0; i < oldGlobalCount; ++i) {
            const contentType = oldSection.readU8();
            const mutability = oldSection.readU8();

            newSection.pushU8(contentType);
            newSection.pushU8(mutability);

            this._readInstantiationTimeInitializer(oldSection, newSection);
        }

        const newGlobalBaseIndex = this._importGlobalCount + oldGlobalCount;

        for (let i = 0; i < addGlobalVariableEntries.length; ++i) {
            const entry = addGlobalVariableEntries[i];

            const contentType = entry.type;
            const mutability = entry.mutability;
            const initializer = entry.initializer;

            newSection.pushU8(contentType);
            newSection.pushU8(mutability);
            newSection.pushBytes(initializer);

            entry.globalIndex._index = newGlobalBaseIndex + i;
        }

        this._newWasm.pushVarU32(newSection.length);
        this._newWasm.pushBytes(newSection.build());
    }

    _parseFunctionSection() {
        const sectionLen = this._oldWasm.readVarU32();
        const sectionBody = this._oldWasm.readBytes(sectionLen);

        const oldSection = new BufferReader(sectionBody);
        const newSection = new BufferBuilder();

        const addFunctionEntries = this._addFunctionEntries;

        const oldFuncCount = oldSection.readVarU32();
        const newFuncCount = oldFuncCount + addFunctionEntries.length;

        newSection.pushVarU32(newFuncCount);

        for (let i = 0; i < oldFuncCount; ++i) {
            const typeIndex = oldSection.readVarU32();
            newSection.pushVarU32(typeIndex);
        }

        const newFuncBaseIndex = this._importFunctionCount + oldFuncCount;

        for (let i = 0; i < addFunctionEntries.length; ++i) {
            const entry = addFunctionEntries[i];

            const typeIndex = entry._typeIndex;
            newSection.pushVarU32(typeIndex);

            entry.functionIndex._index = newFuncBaseIndex + i;
        }

        this._newWasm.pushVarU32(newSection.length);
        this._newWasm.pushBytes(newSection.build());
    }

    _parseExportSection() {
        const sectionLen = this._oldWasm.readVarU32();
        const sectionBody = this._oldWasm.readBytes(sectionLen);

        const oldSection = new BufferReader(sectionBody);
        const newSection = new BufferBuilder();

        const addFunctionEntries = this._addFunctionEntries;
        const addFunctionExportEntries = addFunctionEntries.filter(entry => {
            return entry?.exportName instanceof Array
        });

        const addGlobalVariableEntries = this._addGlobalVariableEntries;
        const addGlobalVariableExportEntries = addGlobalVariableEntries.filter(entry => {
            return entry?.exportName instanceof Array
        })

        const oldExportCount = oldSection.readVarU32();
        const newExportCount = oldExportCount +
            addFunctionExportEntries.length +
            addGlobalVariableExportEntries.length;

        newSection.pushVarU32(newExportCount);

        for (let i = 0; i < oldExportCount; ++i) {
            const fieldNameLen = oldSection.readVarU32();
            const fieldName = oldSection.readBytes(fieldNameLen);

            const kind = oldSection.readU8();
            const index = oldSection.readVarU32();

            newSection.pushVarU32(fieldNameLen);
            newSection.pushBytes(fieldName);
            newSection.pushU8(kind);
            newSection.pushVarU32(index);
        }

        for (let i = 0; i < addFunctionExportEntries.length; ++i) {
            const entry = addFunctionExportEntries[i];
            const fieldNameLen = entry.exportName.length;
            const fieldName = entry.exportName;

            const kind = ExternalKind.Function;
            const index = entry.functionIndex._index;

            newSection.pushVarU32(fieldNameLen);
            newSection.pushBytes(fieldName);
            newSection.pushU8(kind);
            newSection.pushVarU32(index);
        }

        for (let i = 0; i < addGlobalVariableExportEntries.length; ++i) {
            const entry = addGlobalVariableExportEntries[i];
            const fieldNameLen = entry.exportName.length;
            const fieldName = entry.exportName;

            const kind = ExternalKind.Global;
            const index = entry.globalIndex._index;

            newSection.pushVarU32(fieldNameLen);
            newSection.pushBytes(fieldName);
            newSection.pushU8(kind);
            newSection.pushVarU32(index);
        }

        this._newWasm.pushVarU32(newSection.length);
        this._newWasm.pushBytes(newSection.build());
    }

    _expandCodes(codes) {
        return codes.map(code => {
            let newCode = [];

            code.forEach(c => {
                if (c instanceof WasmIndex) {
                    newCode.push(...VAR.u32(c._index));
                } else {
                    newCode.push(c);
                }
            });

            return newCode;
        });
    }

    _expandCode(code) {
        let newCode = [];

        code.forEach(part => {
            console.log(part)
            if (part instanceof WasmIndex) {
                newCode.push(...VAR.u32(part._index));
            }
            else {
                newCode.push(part);
            }
        })

        return newCode;
    }

    _aobScan(data, scan) {
        let scanIndex = 0;

        for (let i = 0; i < data.length;) {
            const val = data[i];

            const scanNow = scan[scanIndex];
            const scanMode = scanNow.mode;
            let scanVal;

            switch (scanMode) {
                case 'insert':
                case 'replace_start':
                case 'replace_end':
                    scanIndex++;
                    break;
                case 'skip':
                    scanIndex++;
                    i++;
                    break;
                case 'value':
                    scanVal = scanNow.value;

                    if (val === scanVal) {
                        scanIndex++;
                    }
                    else {
                        scanIndex = 0;
                    }
                    i++;
                    break;
            }

            if (scanIndex === scan.length) {
                return i - 1;
            }
        }

        return -1;
    }

    _applyAobPatch(oldBody) {
        let body = oldBody;
        let newBody = null;
        let alldone = true;

        this._aobPatchEntries.forEach(entry => {
            if (entry.done) return;

            alldone = false;

            const scan = entry.scan;
            const matchIndex = this._aobScan(body, scan);

            if (matchIndex === -1) return;

            const oldBodyReader = new BufferReader(body);
            const newBodyBuilder = new BufferBuilder();

            const totalMatches = entry.totalMatches;
            const matchEndIndex = matchIndex;
            const matchFirstIndex = matchEndIndex - totalMatches + 1;
            const beforeMatchBytes = oldBodyReader.readBytes(matchFirstIndex);
            const matchBytes = oldBodyReader.readBytes(matchEndIndex - matchFirstIndex + 1);
            const afterMatchBytes = oldBodyReader.readBytesToEnd();
            const matchBytesReader = new BufferReader(matchBytes);

            const codes = entry.codes;

            let codesIndex = 0;
            let startReplace = false;

            newBodyBuilder.pushBytes(beforeMatchBytes);

            scan.forEach(now => {
                switch (now.mode) {
                    case 'skip':
                    case 'value': {
                        const val = matchBytesReader.readU8();

                        if (!startReplace) {
                            newBodyBuilder.pushU8(val);
                        }
                    } break;
                    case 'insert':
                        newBodyBuilder.pushBytes(codes[codesIndex++]);
                        break;
                    case 'replace_start':
                        newBodyBuilder.pushBytes(codes[codesIndex++]);

                        startReplace = true;
                        break;
                    case 'replace_end':
                        startReplace = false;
                        break;
                }
            });

            newBodyBuilder.pushBytes(afterMatchBytes);

            body = newBodyBuilder.build();
            newBody = newBodyBuilder.build();

            entry.onsuccess();
            entry.done = true;
        });

        this._aobPatchFinished = alldone;

        return newBody;
    }

    _parseCodeSection() {
        const sectionLen = this._oldWasm.readVarU32();
        const sectionBody = this._oldWasm.readBytes(sectionLen);

        const oldSection = new BufferReader(sectionBody);
        const newSection = new BufferBuilder();

        const addFunctionEntries = this._addFunctionEntries;

        const oldCodeCount = oldSection.readVarU32();
        const newCodeCount = oldCodeCount + addFunctionEntries.length;

        newSection.pushVarU32(newCodeCount);

        this._aobPatchEntries.forEach(entry => {
            entry.codes = this._expandCodes(entry.codes);
        });

        for (let i = 0; i < oldCodeCount; ++i) {
            const oldFuncLen = oldSection.readVarU32();
            const oldFunc = oldSection.readBytes(oldFuncLen);

            const oldFuncData = new BufferReader(oldFunc);

            const headerBuilder = new BufferBuilder();
            const localCount = oldFuncData.readVarU32();

            headerBuilder.pushVarU32(localCount);

            for (let i = 0; i < localCount; ++i) {
                const count = oldFuncData.readVarU32();
                const varsType = oldFuncData.readU8();

                headerBuilder.pushVarU32(count);
                headerBuilder.pushVarU32(varsType);
            }

            const header = headerBuilder.build();
            const oldBody = oldFuncData.readBytesToEnd();

            if (this._aobPatchFinished) {
                newSection.pushVarU32(oldFuncLen);
                newSection.pushBytes(oldFunc);
                continue;
            }

            const newBody = this._applyAobPatch(oldBody);

            if (!newBody) {
                newSection.pushVarU32(oldFuncLen);
                newSection.pushBytes(oldFunc);
            }
            else {
                const newFuncData = new BufferBuilder();
                newFuncData.pushBytes(header);
                newFuncData.pushBytes(newBody);

                newSection.pushVarU32(newFuncData.length);
                newSection.pushBytes(newFuncData.build());
            }
        }

        for (let i = 0; i < addFunctionEntries.length; ++i) {
            const entry = addFunctionEntries[i];

            const headerBuilder = new BufferBuilder();
            const localCount = entry.locals.length;

            headerBuilder.pushVarU32(localCount);

            for (let i = 0; i < localCount; ++i) {
                const local = entry.locals[i];

                headerBuilder.pushU32(1);
                headerBuilder.pushU8(local);
            }

            const bodyBuilder = new BufferBuilder();
            const code = this._expandCode(entry.code);
            bodyBuilder.pushBytes(code);

            const header = headerBuilder.build();
            const body = bodyBuilder.build();

            const funcData = new BufferBuilder();
            funcData.pushBytes(header);
            funcData.pushBytes(body);

            newSection.pushVarU32(funcData.length);
            newSection.pushBytes(funcData.build());
        }

        this._newWasm.pushVarU32(newSection.length);
        this._newWasm.pushBytes(newSection.build());
    }

    _readSections() {
        while (!this._oldWasm.finished) {
            const sectionID = this._oldWasm.readU8();

            this._newWasm.pushU8(sectionID);

            switch (sectionID) {
                case Section.Type:
                    this._parseTypeSection();
                    break;
                case Section.Import:
                    this._parseImportSection();
                    break;
                case Section.Function:
                    this._parseFunctionSection();
                    break;
                case Section.Global:
                    this._parseGlobalSection();
                    break;
                case Section.Export:
                    this._parseExportSection();
                    break;
                case Section.Code:
                    this._parseCodeSection();
                    break;
                default:
                    if (sectionID >= Section.Custom && sectionID <= Section.DataCount) {
                        const sectionLen = this._oldWasm.readVarU32();
                        const sectionBody = this._oldWasm.readBytes(sectionLen);

                        this._newWasm.pushVarU32(sectionLen);
                        this._newWasm.pushBytes(sectionBody);
                    }
                    else {
                        throw new Error("Invalid section");
                    }
                    break;
            }
        }
    }

    patch() {
        const magic = this._oldWasm.readU32();
        const version = this._oldWasm.readU32();

        if (magic !== 0x6D736100) {
            throw new Error("Invalid magic");
        }

        this._newWasm.pushU32(magic);
        this._newWasm.pushU32(version);

        this._readSections();

        //Download(this._newWasm.build(), "a.wasm");

        return this._newWasm.build();
    }

    _parseScanStr(scanStr) {
        const scanAry = scanStr.split(' ');
        let previousBracket = '';
        let previousScan = '';

        let totalMatches = 0;
        let parsedScan = [];

        const throwErr = function () {
            throw new Error('Invalid entry(aobPatchEntry).scan');
        };

        scanAry.forEach(scan => {
            switch (scan) {
                case '?':
                    if (previousBracket === '[') {
                        throwErr();
                    }

                    parsedScan.push({
                        mode: 'skip'
                    });

                    totalMatches++;
                    break;
                case '[':
                    if (previousBracket === '[') {
                        throwErr();
                    }

                    parsedScan.push({
                        mode: 'replace_start'
                    });

                    previousBracket = '[';
                    break;
                case ']':
                    if (previousBracket === ']' || previousScan === '[') {
                        throwErr();
                    }

                    parsedScan.push({
                        mode: 'replace_end'
                    });

                    previousBracket = ']';
                    break;
                case '|':
                    if (previousBracket === '[' || previousScan === '|') {
                        throwErr();
                    }

                    parsedScan.push({
                        mode: 'insert'
                    });
                    break;
                default: {
                    let parsedVal = parseInt(scan, 16);

                    if (isNaN(parsedVal)) {
                        throwErr();
                    }

                    parsedScan.push({
                        mode: 'value',
                        value: parsedVal
                    });

                    totalMatches++;
                } break;
            }

            previousScan = scan;
        });

        return {
            scan: parsedScan,
            totalMatches: totalMatches
        };
    }

    aobPatchEntry(entry) {
        const scanStr = entry.scan;
        const parsed = this._parseScanStr(scanStr);

        const needCodeCount = parsed.scan.filter(scanUnit => {
            switch (scanUnit.mode) {
                case 'insert':
                case 'replace_start':
                    return true;
                default:
                    return false;
            }
        }).length;

        const entryCode = entry.code;
        const entryCodes = entry.codes;
        let codes;

        if ((entryCode && entryCodes) ||
            (!entryCode && !entryCodes)) {
            throw new Error("Invalid entry.code entry.codes parameter");
        }

        if (needCodeCount === 0) {
            throw new Error("Invalid entry.code entry.codes parameter");
        }
        else if (needCodeCount === 1) {
            if (!entryCode) throw new Error("Invalid entry.code");

            codes = [];
            codes.push(entryCode);
        }
        else {
            if (!entryCodes) throw new Error("Invalid entry.codes");

            codes = entryCodes;
        }

        codes = codes.map(code => {
            let newCode = [];

            code.forEach(c => {
                if (c instanceof Array) {
                    newCode.push(...c);
                } else {
                    newCode.push(c);
                }
            });

            return newCode;
        });

        this._aobPatchEntries.push({
            name: entry.name,
            scan: parsed.scan,
            totalMatches: parsed.totalMatches,
            codes: codes,
            onsuccess: entry.onsuccess,
            done: false,
        });
    }

    addFunctionEntry(entry) {
        if (!entry.params ||
            !entry.return ||
            !entry.code ||
            !(entry.params instanceof Array) ||
            !(entry.code instanceof Array)
        ) {
            throw new Error("Invalid entry");
        }

        if (!entry.locals) {
            entry.locals = [];
        }

        const locals = entry.locals;
        const fixedLocals = locals.map(local => {
            switch (typeof local) {
                case "number": return local;
                case "string": return this._string2type(local);
                default: throw new Error("Invalid locals");
            }
        });

        entry.locals = fixedLocals;

        const params = entry.params;
        const fixedParams = params.map(params => {
            switch (typeof params) {
                case "number": return params;
                case "string": return this._string2type(params);
                default: throw new Error("Invalid locals");
            }
        });

        entry.params = fixedParams;
        entry.return = this._string2type(entry.return);

        if (entry.exportName) {
            entry.exportName = this._string2bytes(entry.exportName);
        }

        let newCode = [];

        entry.code.forEach(part => {
            console.log(part)
            if (part instanceof Array) {
                newCode.push(...part);
            }
            else {
                newCode.push(part);
            }
        })

        entry.code = newCode;

        const index = new WasmIndex();
        entry.functionIndex = index;

        this._addFunctionEntries.push(entry);

        return index;
    }

    addGlobalVariableEntry(entry) {
        /*
        if (!entry.type ||
            !entry.value ||
            !entry.mutability
        ) {
            throw new Error("Invalid entry");
        }
        */

        entry.mutability = new Number(entry.mutability); // boolean to number
        entry.initializer = this._createInstantiationTimeInitializer(entry.type, entry.value);

        entry.type = this._string2type(entry.type);

        const index = new WasmIndex();
        entry.globalIndex = index;

        if (entry.exportName) {
            entry.exportName = this._string2bytes(entry.exportName);
        }

        this._addGlobalVariableEntries.push(entry);

        return index;
    }
}


let config = new Object({ fov:330, sensitivity:0.15, aimbot:true, esp:true, threshold:4.5 });


	const WebGL = WebGL2RenderingContext.prototype;
	HTMLCanvasElement.prototype.getContext = new Proxy( HTMLCanvasElement.prototype.getContext, {
		apply( target, thisArgs, args ){
			console.log('UGHHHH' + args[1])
			if (args[1]){

				args[1].preserveDrawingBuffer = true;
			}
			return Reflect.apply(...arguments);
		}
	});

	WebGL.shaderSource = new Proxy( WebGL.shaderSource, {
		apply( target, thisArgs, args ) {
			console.log('UGHHHH' + args[1])
			if ( args[ 1 ].indexOf( 'gl_Position' ) > - 1 ) {

				args[ 1 ] = args[ 1 ].replace( 'void main', `

					out float vDepth;
					uniform bool enabled;
					uniform float threshold;

					void main

				` ).replace( /return;/, `

					vDepth = gl_Position.z;

					if ( enabled && vDepth > threshold ) {

						gl_Position.z = 1.0;

					}

				` );

			} else if ( args[ 1 ].indexOf( 'SV_Target0' ) > - 1 ) {

				args[ 1 ] = args[ 1 ].replace( 'void main', `

					in float vDepth;
					uniform bool enabled;
					uniform float threshold;

					void main

				` ).replace( /return;/, `

					if ( enabled && vDepth > threshold ) {

						SV_Target0 = vec4( 1.0, 0.0, 0.0, 1.0 );

					}

				` );

			}

			return Reflect.apply( ...arguments );

		}
	} );

	WebGL.getUniformLocation = new Proxy( WebGL.getUniformLocation, {
		apply( target, thisArgs, [ program, name ] ) {
			
			const result = Reflect.apply( ...arguments );

			if ( result ) {

				result.name = name;
				result.program = program;

			}

			return result;

		}
	} );

	WebGL.uniform4fv = new Proxy( WebGL.uniform4fv, {
		apply( target, thisArgs, args ) {

			if ( args[ 0 ].name === 'hlslcc_mtx4x4unity_ObjectToWorld' ) {

				args[ 0 ].program.isUIProgram = true;

			}

			return Reflect.apply( ...arguments );

		}
	} );

	let movementX = 0, movementY = 0;
	let count = 0;

	WebGL.drawElements = new Proxy( WebGL.drawElements, {
		apply( target, thisArgs, args ) {

			const program = thisArgs.getParameter( thisArgs.CURRENT_PROGRAM );

			if ( ! program.uniforms ) {

				program.uniforms = {
					enabled: thisArgs.getUniformLocation( program, 'enabled' ),
					threshold: thisArgs.getUniformLocation( program, 'threshold' )
				};

			}

			const couldBePlayer = args[ 1 ] > 4000;

			thisArgs.uniform1i( program.uniforms.enabled, config.esp && couldBePlayer );
			thisArgs.uniform1f( program.uniforms.threshold, config.threshold );

			args[ 0 ] = false && ! program.isUIProgram && args[ 1 ] > 6 ? thisArgs.LINES : args[ 0 ];

			Reflect.apply( ...arguments );

			if ( config.aimbot && couldBePlayer ) {

				const width = Math.min( config.fov, thisArgs.canvas.width );
				const height = Math.min( config.fov, thisArgs.canvas.height );

				const pixels = new Uint8Array( width * height * 4 );

				const centerX = thisArgs.canvas.width / 2;
				const centerY = thisArgs.canvas.height / 2;

				const x = Math.floor( centerX - width / 2 );
				const y = Math.floor( centerY - height / 2 );

				thisArgs.readPixels( x, y, width, height, thisArgs.RGBA, thisArgs.UNSIGNED_BYTE, pixels );

				for ( let i = 0; i < pixels.length; i += 4 ) {

					if ( pixels[ i ] === 255 && pixels[ i + 1 ] === 0 && pixels[ i + 2 ] === 0 && pixels[ i + 3 ] === 255 ) {

						const idx = i / 4;

						const dx = idx % width;
						const dy = ( idx - dx ) / width;

						movementX += ( x + dx - centerX );
						movementY += - ( y + dy - centerY );

						count ++;

					}

				}

			}

		}
	} );

	window.requestAnimationFrame = new Proxy( window.requestAnimationFrame, {
		apply( target, thisArgs, args ) {

			args[ 0 ] = new Proxy( args[ 0 ], {
				apply() {

					const isPlaying = document.getElementById( '#canvas' ).style.cursor === 'none';

					if ( count > 0 && isPlaying ) {

						const f = config.sensitivity / count;

						movementX *= f;
						movementY *= f;

						window.dispatchEvent( new MouseEvent( 'mousemove', { movementX, movementY } ) );
					}

					movementX = 0;
					movementY = 0;
					count = 0;

					return Reflect.apply( ...arguments );

				}
			} );

			return Reflect.apply( ...arguments );

		}
	} )

	const fov = document.createElement('div');
	fov.id = 'FOV'
	window.addEventListener( 'DOMContentLoaded', function () {
		const credit = document.createElement('div')
		credit.innerText = `Developers \n Sean V \n Kevin D`
		credit.style.position = 'absolute'
		credit.style.top = '4%'
		credit.style.color = 'yellow'
		document.body.appendChild(credit)

		fov.style.position = 'absolute'
		fov.style.padding = 0;
		fov.style.margin = 0;
		fov.style.top = '50%'
		fov.style.left = '50%'
		fov.style.border = '5px solid yellow'
		fov.style.borderRadius = '50%';
		fov.style.height = `${config.fov}px`;
		fov.style.width = `${config.fov}px`;
		fov.style.transform = "translate(-50%,-50%)"
		document.body.appendChild(fov)
		var colors = ["red", "orange", "yellow", "green", "blue", "indigo", "violet"];

		var i = 1;

		// window.setInterval(function(){
		// 	fov.style.borderColor = colors[i];
		// 	credit.style.color = colors[i]
		// 	i++;
		// 	if (i === colors.length){
		// 		i=0;
		// 	}
		// }, 100);
	})

	document.onkeydown = function (event) {
		switch (event.keyCode) {

		case 38:
				config.fov += 10
				document.getElementById('FOV').style.height = `${config.fov}px`;
				document.getElementById('FOV').style.width = `${config.fov}px`;
			break;
		case 40:
				config.fov -= 10
				document.getElementById('FOV').style.height = `${config.fov}px`;
				document.getElementById('FOV').style.width = `${config.fov}px`;
			break;
		}
	};
	//RAPID FIRE
	const wasm = WebAssembly;
	const oldInstantiate = wasm.instantiate; //

	wasm.instantiate = async function(bufferSource, importObject) {
		const patcher = new WasmPatcher(bufferSource);

	
		patcher.aobPatchEntry({
			scan: '2A ? ? | 38 ? ? C 2 B 20 0',
			code: [
				OP.drop,
				OP.f32.const, VAR.f32(0)
			],
			onsuccess: () => {},
			onerror: e =>{
				alert('Failed patching Rapid Fire')
			}
		});


		const result = await oldInstantiate(patcher.patch(), importObject);

		return result;
	};

