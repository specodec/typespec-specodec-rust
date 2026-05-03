import {
  EmitContext,
  emitFile,
  Model,
  Type,
} from "@typespec/compiler";
import {
  collectServices,
  ServiceInfo,
  BaseEmitterOptions,
  FieldInfo,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  arrayElementType,
  recordElementType,
  toSnakeCase,
  toScreamingSnakeCase,
  checkAndReportReservedKeywords,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

function typeToRust(t: Type): string {
  const n = scalarName(t);
  if (n === "string") return "String";
  if (n === "boolean") return "bool";
  if (n === "int8") return "i8";
  if (n === "int16") return "i16";
  if (n === "int32" || n === "integer") return "i32";
  if (n === "int64") return "i64";
  if (n === "uint8") return "u8";
  if (n === "uint16") return "u16";
  if (n === "uint32") return "u32";
  if (n === "uint64") return "u64";
  if (n === "float32") return "f32";
  if (n === "float64" || n === "float" || n === "decimal") return "f64";
  if (n === "bytes") return "Vec<u8>";
  if (isArrayType(t)) return `Vec<${typeToRust(arrayElementType(t))}>`;
  if (isRecordType(t)) return `std::collections::HashMap<String, ${typeToRust(recordElementType(t))}>`;
  if (t.kind === "Model" && (t as Model).name) return (t as Model).name;
  return "String";
}

function defaultFor(t: Type): string {
  const n = scalarName(t);
  if (n === "string") return "String::new()";
  if (n === "boolean") return "false";
  if (n === "float32" || n === "float64" || n === "float" || n === "decimal") return "0.0";
  if (n === "bytes") return "Vec::new()";
  if (["int8","int16","int32","int64","uint8","uint16","uint32","uint64","integer"].includes(n)) return "0";
  if (isArrayType(t)) return "Vec::new()";
  if (isRecordType(t)) return "std::collections::HashMap::new()";
  if (isModelType(t)) return `${(t as Model).name} { ..Default::default() }`;
  return "String::new()";
}

function needsBox(fieldType: Type, structName: string): boolean {
  if (fieldType.kind === "Model" && (fieldType as Model).name === structName) return true;
  if (isArrayType(fieldType)) {
    const elem = arrayElementType(fieldType);
    if (elem.kind === "Model" && (elem as Model).name === structName) return true;
  }
  if (isRecordType(fieldType)) {
    const elem = recordElementType(fieldType);
    if (elem.kind === "Model" && (elem as Model).name === structName) return true;
  }
  return false;
}

function typeToRustField(t: Type, optional: boolean, structName: string): string {
  const rt = typeToRust(t);
  const boxed = needsBox(t, structName);
  if (optional) return boxed ? `Option<Box<${rt}>>` : `Option<${rt}>`;
  return boxed ? `Box<${rt}>` : rt;
}

function writeExpr(t: Type, expr: string): string {
  const n = scalarName(t);
  if (n === "string") return `w.write_string(${expr})`;
  if (n === "boolean") return `w.write_bool(*${expr})`;
  if (n === "int8") return `w.write_int32(*${expr} as i32)`;
  if (n === "int16") return `w.write_int32(*${expr} as i32)`;
  if (n === "int32" || n === "integer") return `w.write_int32(*${expr})`;
  if (n === "int64") return `w.write_int64(*${expr})`;
  if (n === "uint8") return `w.write_uint32(*${expr} as u32)`;
  if (n === "uint16") return `w.write_uint32(*${expr} as u32)`;
  if (n === "uint32") return `w.write_uint32(*${expr})`;
  if (n === "uint64") return `w.write_uint64(*${expr})`;
  if (n === "float32") return `w.write_float32(*${expr})`;
  if (n === "float64" || n === "float" || n === "decimal") return `w.write_float64(*${expr})`;
  if (n === "bytes") return `w.write_bytes(${expr})`;
  if (isArrayType(t)) {
    const elem = arrayElementType(t);
    const lenExpr = expr.startsWith("&") ? expr.substring(1) : expr;
    return `w.begin_array(${lenExpr}.len()); for _e in ${expr} { w.next_element(); ${writeExpr(elem, "_e")} }; w.end_array()`;
  }
  if (isRecordType(t)) {
    const elem = recordElementType(t);
    const lenExpr = expr.startsWith("&") ? expr.substring(1) : expr;
    return `w.begin_object(${lenExpr}.len()); for (_k, _v) in ${expr} { w.write_field(_k); ${writeExpr(elem, "_v")} }; w.end_object()`;
  }
  if (t.kind === "Model" && (t as Model).name) return `${toSnakeCase((t as Model).name)}_write(${expr}, w)`;
  return `w.write_string(${expr})`;
}

function readExpr(t: Type, optional?: boolean, boxed?: boolean): string {
  const wrapBox = (expr: string) => boxed ? `Box::new(${expr})` : expr;
  const n = scalarName(t);
  let expr: string;
  switch (n) {
    case "string": expr = "r.read_string()?"; break;
    case "boolean": expr = "r.read_bool()?"; break;
    case "int8": expr = "r.read_int32()? as i8"; break;
    case "int16": expr = "r.read_int32()? as i16"; break;
    case "int32": case "integer": expr = "r.read_int32()?"; break;
    case "int64": expr = "r.read_int64()?"; break;
    case "uint8": expr = "r.read_uint32()? as u8"; break;
    case "uint16": expr = "r.read_uint32()? as u16"; break;
    case "uint32": expr = "r.read_uint32()?"; break;
    case "uint64": expr = "r.read_uint64()?"; break;
    case "float32": expr = "r.read_float32()?"; break;
    case "float64": case "float": case "decimal": expr = "r.read_float64()?"; break;
    case "bytes": expr = "r.read_bytes()?"; break;
    default:
      if (isArrayType(t)) {
        const elem = arrayElementType(t);
        const rt = typeToRust(elem);
        const arrExpr = `{ let mut _arr: Vec<${rt}> = Vec::new(); r.begin_array()?; while r.has_next_element()? { _arr.push(${readExpr(elem, false, false)}); } r.end_array()?; _arr }`;
        if (optional) return `Some(${arrExpr})`;
        return arrExpr;
      }
      if (isRecordType(t)) {
        const elem = recordElementType(t);
        const rt = typeToRust(elem);
        const mapExpr = `{ let mut _map: std::collections::HashMap<String, ${rt}> = std::collections::HashMap::new(); r.begin_object()?; while r.has_next_field()? { let _k = r.read_field_name()?; _map.insert(_k, ${readExpr(elem, false, false)}); } r.end_object()?; _map }`;
        if (optional) return `Some(${mapExpr})`;
        return mapExpr;
      }
      if (t.kind === "Model" && (t as Model).name) {
        const decodeCall = `${toSnakeCase((t as Model).name)}_decode(r)?`;
        const boxedCall = wrapBox(decodeCall);
        if (optional) return `if r.is_null()? { r.read_null()?; None } else { Some(${boxedCall}) }`;
        return boxedCall;
      }
      expr = "r.read_string()?"; break;
  }
  if (optional) return `Some(${expr})`;
  return expr;
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  for (const svc of services) {
    const lines: string[] = [];
    lines.push("// Generated by @specodec/typespec-emitter-rust. DO NOT EDIT.");
    lines.push("use specodec::{SpecWriter, SpecReader, SpecCodec, SCodecError};");
    lines.push("");

    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      const snakeName = toSnakeCase(m.name);
      const reqCount = fields.filter(f => !f.optional).length;

      lines.push(`#[derive(Debug, Clone, Default)]`);
      lines.push(`pub struct ${m.name} {`);
      for (const f of fields) {
        lines.push(`    pub ${f.name}: ${typeToRustField(f.type, f.optional, m.name)},`);
      }
      lines.push(`}`);
      lines.push("");

      lines.push(`pub fn ${snakeName}_write(obj: &${m.name}, w: &mut dyn SpecWriter) {`);
      lines.push(`    let mut _n: usize = ${reqCount};`);
      for (const f of fields.filter(f => f.optional)) {
        lines.push(`    if obj.${f.name}.is_some() { _n += 1; }`);
      }
      lines.push(`    w.begin_object(_n);`);
      for (const f of fields) {
        if (f.optional) {
          lines.push(`    if let Some(ref _v) = obj.${f.name} { w.write_field("${f.name}"); ${writeExpr(f.type, "_v")}; }`);
        } else {
          lines.push(`    w.write_field("${f.name}"); ${writeExpr(f.type, `&obj.${f.name}`)};`);
        }
      }
      lines.push(`    w.end_object();`);
      lines.push(`}`);
      lines.push("");

      lines.push(`pub fn ${snakeName}_decode(r: &mut dyn SpecReader) -> Result<${m.name}, SCodecError> {`);
      for (const f of fields) {
        const rt = typeToRust(f.type);
        const boxed = needsBox(f.type, m.name);
        if (f.optional) {
          lines.push(`    let mut _${f.name}: ${boxed ? `Option<Box<${rt}>>` : `Option<${rt}>`} = None;`);
        } else {
          const varType = boxed ? `Box<${rt}>` : rt;
          const defVal = boxed ? `Box::new(${defaultFor(f.type)})` : defaultFor(f.type);
          lines.push(`    let mut _${f.name}: ${varType} = ${defVal};`);
        }
      }
      lines.push(`    r.begin_object()?;`);
      lines.push(`    while r.has_next_field()? {`);
      lines.push(`        match r.read_field_name()?.as_str() {`);
      for (const f of fields) {
        const boxed = needsBox(f.type, m.name);
        lines.push(`            "${f.name}" => { _${f.name} = ${readExpr(f.type, f.optional, boxed)}; }`);
      }
      lines.push(`            _ => { r.skip()?; }`);
      lines.push(`        }`);
      lines.push(`    }`);
      lines.push(`    r.end_object()?;`);
      lines.push(`    Ok(${m.name} { ${fields.map(f => `${f.name}: _${f.name}`).join(", ")} })`);
      lines.push(`}`);
      lines.push("");

      lines.push(`#[allow(non_upper_case_globals)]`);
      lines.push(`pub static ${m.name}Codec: SpecCodec<${m.name}> = SpecCodec {`);
      lines.push(`    encode: ${snakeName}_write,`);
      lines.push(`    decode: ${snakeName}_decode,`);
      lines.push(`};`);
      lines.push("");
    }

    const fileName = `${toSnakeCase(svc.serviceName)}_types.rs`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
