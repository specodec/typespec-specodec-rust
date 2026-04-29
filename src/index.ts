import {
  EmitContext, emitFile, listServices, navigateTypesInNamespace,
  Model, Namespace, Interface, Program, Type, Scalar,
} from "@typespec/compiler";

export type EmitterOptions = { "emitter-output-dir": string };

interface FieldInfo { name: string; type: Type; optional: boolean; }
interface ServiceInfo { namespace: Namespace; iface: Interface; serviceName: string; models: Model[]; }

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  return fields;
}

function scalarName(t: Type): string { return t.kind === "Scalar" ? (t as Scalar).name : ""; }
function isArray(t: Type): boolean { return t.kind === "Model" && !!(t as Model).indexer; }
function arrayElem(t: Type): Type { return (t as Model).indexer!.value; }

function typeToRust(t: Type): string {
  if (isArray(t)) return `Vec<${typeToRust(arrayElem(t))}>`;
  const s = scalarName(t);
  switch (s) {
    case "string": return "String";
    case "boolean": return "bool";
    case "int8": return "i8";
    case "int16": return "i16";
    case "int32": case "integer": return "i32";
    case "int64": return "i64";
    case "uint8": return "u8";
    case "uint16": return "u16";
    case "uint32": return "u32";
    case "uint64": return "u64";
    case "float32": return "f32";
    case "float64": case "float": case "decimal": return "f64";
    case "bytes": return "Vec<u8>";
  }
  if (t.kind === "Model" && (t as Model).name) return (t as Model).name;
  return "String";
}

function defaultFor(rustType: string): string {
  if (rustType === "String") return "String::new()";
  if (rustType === "bool") return "false";
  if (rustType === "f32" || rustType === "f64") return "0.0";
  if (rustType.startsWith("Vec<")) return "Vec::new()";
  return "0";
}

function writeExpr(t: Type, expr: string): string {
  if (isArray(t)) {
    const elem = arrayElem(t);
    return `w.begin_array(${expr}.len()); for _e in &${expr.replace(/^&/, "")} { w.next_element(); ${writeExprInner(elem, "_e")} }; w.end_array()`;
  }
  return writeExprInner(t, expr);
}

function writeExprInner(t: Type, expr: string): string {
  if (isArray(t)) return writeExpr(t, expr);
  const s = scalarName(t);
  switch (s) {
    case "string": return `w.write_string(${expr.startsWith("&") ? expr : "&" + expr})`;
    case "boolean": return `w.write_bool(${expr})`;
    case "int8": case "int16": case "int32": case "integer": return `w.write_int32(${expr} as i32)`;
    case "int64": return `w.write_int64(${expr})`;
    case "uint8": case "uint16": case "uint32": return `w.write_uint32(${expr} as u32)`;
    case "uint64": return `w.write_uint64(${expr})`;
    case "float32": return `w.write_float32(${expr})`;
    case "float64": case "float": case "decimal": return `w.write_float64(${expr})`;
    case "bytes": return `w.write_bytes(${expr.startsWith("&") ? expr : "&" + expr})`;
  }
  if (t.kind === "Model" && (t as Model).name) {
    const fn_ = toSnake((t as Model).name) + "_encode_json_inner";
    return `${fn_}(${expr}, &mut w)`;
  }
  return `w.write_string(${expr.startsWith("&") ? expr : "&" + expr})`;
}

function readExpr(t: Type): string {
  if (isArray(t)) {
    const elem = arrayElem(t);
    const rt = typeToRust(elem);
    return `{ let mut _arr: Vec<${rt}> = Vec::new(); r.begin_array()?; while r.has_next_element()? { _arr.push(${readExpr(elem)}); } r.end_array()?; _arr }`;
  }
  const s = scalarName(t);
  switch (s) {
    case "string": return "r.read_string()?";
    case "boolean": return "r.read_bool()?";
    case "int8": case "int16": case "int32": case "integer": return "r.read_int32()?";
    case "int64": return "r.read_int64()?";
    case "uint8": case "uint16": case "uint32": return "r.read_uint32()?";
    case "uint64": return "r.read_uint64()?";
    case "float32": return "r.read_float32()?";
    case "float64": case "float": case "decimal": return "r.read_float64()?";
    case "bytes": return "r.read_bytes()?";
  }
  if (t.kind === "Model" && (t as Model).name) return `${toSnake((t as Model).name)}_decode(r)?`;
  return "r.read_string()?";
}

function toSnake(name: string): string {
  return name.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
}

function toScreaming(name: string): string {
  return toSnake(name).toUpperCase();
}

function countRequiredFields(fields: FieldInfo[]): number {
  return fields.filter(f => !f.optional).length;
}

function collectServices(program: Program): ServiceInfo[] {
  const services = listServices(program);
  const result: ServiceInfo[] = [];
  function collectFromNs(ns: Namespace) {
    for (const [, iface] of ns.interfaces) {
      const models: Model[] = []; const seen = new Set<string>();
      navigateTypesInNamespace(ns, { model: (m: Model) => { if (m.name && !seen.has(m.name)) { models.push(m); seen.add(m.name); } } });
      result.push({ namespace: ns, iface, serviceName: iface.name, models });
    }
  }
  for (const svc of services) collectFromNs(svc.type);
  if (result.length === 0) {
    const g = program.getGlobalNamespaceType();
    for (const [, ns] of g.namespaces) collectFromNs(ns);
    collectFromNs(g);
  }
  return result;
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;

  for (const svc of collectServices(program)) {
    const lines: string[] = [];
    lines.push("// Generated by @specodec/typespec-specodec-rust. DO NOT EDIT.");
    lines.push("use specodec::{JsonWriter, MsgPackWriter, SpecReader, SpecCodec, SCodecError};");
    lines.push("");

    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      const snake = toSnake(m.name);
      const screaming = toScreaming(m.name);

      lines.push(`#[derive(Debug, Clone)]`);
      lines.push(`pub struct ${m.name} {`);
      for (const f of fields) {
        const rt = typeToRust(f.type);
        lines.push(`    pub ${f.name}: ${f.optional ? `Option<${rt}>` : rt},`);
      }
      lines.push(`}`);
      lines.push("");

      lines.push(`pub fn ${snake}_encode_json(obj: &${m.name}) -> Vec<u8> {`);
      lines.push(`    let mut w = JsonWriter::new();`);
      lines.push(`    w.begin_object();`);
      for (const f of fields) {
        if (f.optional) {
          lines.push(`    if let Some(ref _v) = obj.${f.name} { w.write_field("${f.name}"); ${writeExpr(f.type, "_v")}; }`);
        } else {
          const expr = scalarName(f.type) === "string" ? `&obj.${f.name}` : `obj.${f.name}`;
          lines.push(`    w.write_field("${f.name}"); ${writeExpr(f.type, expr)};`);
        }
      }
      lines.push(`    w.end_object();`);
      lines.push(`    w.into_bytes()`);
      lines.push(`}`);
      lines.push("");

      lines.push(`pub fn ${snake}_encode_msgpack(obj: &${m.name}) -> Vec<u8> {`);
      const req = countRequiredFields(fields);
      const optFields = fields.filter(f => f.optional);
      lines.push(`    let mut _n: usize = ${req};`);
      for (const f of optFields) {
        lines.push(`    if obj.${f.name}.is_some() { _n += 1; }`);
      }
      lines.push(`    let mut w = MsgPackWriter::new();`);
      lines.push(`    w.begin_object(_n);`);
      for (const f of fields) {
        if (f.optional) {
          lines.push(`    if let Some(ref _v) = obj.${f.name} { w.write_field("${f.name}"); ${writeExpr(f.type, "_v")}; }`);
        } else {
          const expr = scalarName(f.type) === "string" ? `&obj.${f.name}` : `obj.${f.name}`;
          lines.push(`    w.write_field("${f.name}"); ${writeExpr(f.type, expr)};`);
        }
      }
      lines.push(`    w.end_object();`);
      lines.push(`    w.into_bytes()`);
      lines.push(`}`);
      lines.push("");

      lines.push(`pub fn ${snake}_decode(r: &mut dyn SpecReader) -> Result<${m.name}, SCodecError> {`);
      for (const f of fields) {
        const rt = typeToRust(f.type);
        if (f.optional) {
          lines.push(`    let mut _${f.name}: Option<${rt}> = None;`);
        } else {
          lines.push(`    let mut _${f.name}: ${rt} = ${defaultFor(rt)};`);
        }
      }
      lines.push(`    r.begin_object()?;`);
      lines.push(`    while r.has_next_field()? {`);
      lines.push(`        match r.read_field_name()?.as_str() {`);
      for (const f of fields) {
        if (f.optional) {
          lines.push(`            "${f.name}" => { _${f.name} = Some(${readExpr(f.type)}); }`);
        } else {
          lines.push(`            "${f.name}" => { _${f.name} = ${readExpr(f.type)}; }`);
        }
      }
      lines.push(`            _ => { r.skip()?; }`);
      lines.push(`        }`);
      lines.push(`    }`);
      lines.push(`    r.end_object()?;`);
      const constructFields = fields.map(f => `${f.name}: _${f.name}`).join(", ");
      lines.push(`    Ok(${m.name} { ${constructFields} })`);
      lines.push(`}`);
      lines.push("");

      lines.push(`pub static ${screaming}_CODEC: SpecCodec<${m.name}> = SpecCodec {`);
      lines.push(`    encode_json: ${snake}_encode_json,`);
      lines.push(`    encode_msgpack: ${snake}_encode_msgpack,`);
      lines.push(`    decode: ${snake}_decode,`);
      lines.push(`};`);
      lines.push("");
    }

    const snakeSvc = toSnake(svc.serviceName);
    await emitFile(program, { path: `${outputDir}/${snakeSvc}_types.rs`, content: lines.join("\n") });
  }
}
