import { check } from './util.mjs';
export function validateForm(schema, value, location = '表单', depth = 0) {
  check(depth < 20,'表单嵌套过深');
  if (schema.enum) check(schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)),`${location} 的选项无效`);
  const type = schema.type ?? (schema.properties ? 'object' : null);
  if (type === 'object') {
    check(value && typeof value === 'object' && !Array.isArray(value),`${location} 必须是对象`);
    for (const key of schema.required ?? []) check(Object.hasOwn(value,key) && value[key] !== '' && value[key] !== undefined,`${location}.${key} 为必填项`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.additionalProperties === false) check(Object.hasOwn(schema.properties ?? {},key),`${location} 包含未知字段`);
      if (schema.properties?.[key]) validateForm(schema.properties[key],child,`${location}.${key}`,depth+1);
    }
  } else if (type === 'array') {
    check(Array.isArray(value),`${location} 必须是数组`); check(value.length<=Math.min(schema.maxItems??200,200)&&value.length>=(schema.minItems??0),`${location} 的项目数量无效`);
    if (schema.items) value.forEach((v,i)=>validateForm(schema.items,v,`${location}[${i}]`,depth+1));
  } else if (type === 'string') {
    check(typeof value === 'string',`${location} 必须是文字`); check(value.length<=Math.min(schema.maxLength??10000,10000)&&value.length>=(schema.minLength??0),`${location} 的长度无效`);
  } else if (type === 'number' || type === 'integer') {
    check(typeof value==='number'&&Number.isFinite(value)&&(type!=='integer'||Number.isInteger(value)),`${location} 必须是数字`);
    check(value>=(schema.minimum??-Infinity)&&value<=(schema.maximum??Infinity),`${location} 超出范围`);
  } else if(type==='boolean') check(typeof value==='boolean',`${location} 必须是布尔值`);
}
