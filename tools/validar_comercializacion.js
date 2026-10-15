// Controlador de calidad del tablero de Comercialización.
// Uso: node tools/validar_comercializacion.js [ruta/a/dashboard/index.html]
// Sale con código 1 si encuentra errores. Los avisos (WARN) no frenan la publicación pero hay que revisarlos.
const fs = require('fs');
const path = process.argv[2] || 'dashboard/index.html';
const html = fs.readFileSync(path, 'utf8');
const errors = [], warns = [];
const err = m => errors.push(m), warn = m => warns.push(m);

// 1) Estructura del HTML y sintaxis JS
if ((html.match(/<!DOCTYPE/gi) || []).length !== 1) err('El HTML no tiene exactamente un DOCTYPE');
const opens = (html.match(/<script/gi) || []).length, closes = (html.match(/<\/script>/gi) || []).length;
if (opens !== closes) err(`Etiquetas <script> desbalanceadas (${opens} abren, ${closes} cierran)`);
try {
  const vm = require('vm');
  [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m, i) => { try { new vm.Script(m[1]); } catch (e) { err(`Error de sintaxis JS en script #${i}: ${e.message}`); } });
} catch (e) { err('No se pudo chequear sintaxis: ' + e.message); }

// 2) Datos embebidos
const m = html.match(/const EMBEDDED = (\{[\s\S]*?\});\n/);
if (!m) { err('No se encontró el bloque EMBEDDED'); report(); }
let E; try { E = JSON.parse(m[1]); } catch (e) { err('EMBEDDED no es JSON válido: ' + e.message); report(); }

const MESES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const latestSummary = {};
for (const crop of ['soja', 'maiz', 'trigo']) {
  const rows = E.raw[crop];
  if (!rows || !rows.length) { err(`${crop}: sin filas`); continue; }
  const seen = new Set();
  const campañas = [...new Set(rows.map(r => r.campaña))].sort();
  const vigentes = new Set(campañas.slice(-1)); // se exige rigor solo a la campaña actual; la historia de la planilla tiene filas sucias conocidas
  rows.forEach(r => {
    const id = `${crop} ${r.campaña} ${r.mes_ano}`;
    const e = vigentes.has(r.campaña) ? err : warn;
    if (seen.has(id)) e(`${id}: fila duplicada`); seen.add(id);
    const d = new Date(r.fecha_info);
    if (isNaN(d)) { e(`${id}: fecha_info inválida (${r.fecha_info})`); return; }
    const mes = r.mes_ano.split('-')[0];
    if (MESES[d.getMonth()] !== mes && MESES[(d.getMonth() + 11) % 12] !== mes) warn(`${id}: el mes no coincide con la fecha ${r.fecha_info}`);
    ['produccion','total_comprado','expo','industria','queda_vender_tn'].forEach(k => { if (r[k] == null || isNaN(r[k])) e(`${id}: falta ${k}`); else if (r[k] < 0) e(`${id}: ${k} negativo`); });
    if (r.total_comprado > r.produccion * 1.15) e(`${id}: total comprado supera la producción en más de 15%`);
    // coherencias aritméticas (tolerancia por redondeos de la fuente)
    if (r.produccion != null && r.total_comprado != null && r.queda_vender_tn != null && !near(r.produccion - r.total_comprado, r.queda_vender_tn, Math.max(5, r.produccion * 0.001))) {
      if (vigentes.has(r.campaña)) err(`${id}: queda por vender (${r.queda_vender_tn}) ≠ producción − comprado (${(r.produccion - r.total_comprado).toFixed(1)})`); else warn(`${id}: queda por vender ≠ producción − comprado`);
    }
    if (r.expo != null && r.industria != null && r.total_comprado != null && !near(r.expo + r.industria, r.total_comprado, Math.max(5, r.total_comprado * 0.002)))
      { if (vigentes.has(r.campaña)) err(`${id}: expo + industria (${(r.expo + r.industria).toFixed(1)}) ≠ total comprado (${r.total_comprado})`); else warn(`${id}: expo + industria ≠ total comprado`); }
    if (r.pct_comprado != null && r.produccion && !near(100 * r.total_comprado / r.produccion, r.pct_comprado, 1.5)) e(`${id}: % comprado (${r.pct_comprado}) no coincide con total/producción (${(100 * r.total_comprado / r.produccion).toFixed(1)})`);
  });
  // la campaña vigente debe ser creciente en el tiempo
  const cur = rows.filter(r => r.campaña === rows.reduce((a, r) => r.campaña > a ? r.campaña : a, '00/00')).sort((a, b) => new Date(a.fecha_info) - new Date(b.fecha_info));
  for (let i = 1; i < cur.length; i++) {
    if (cur[i].total_comprado < cur[i - 1].total_comprado - 1) err(`${crop}: el total comprado BAJA entre ${cur[i - 1].mes_ano} y ${cur[i].mes_ano}`);
    if (new Date(cur[i].fecha_info) - new Date(cur[i - 1].fecha_info) > 70 * 864e5) warn(`${crop}: hueco de más de 70 días entre ${cur[i - 1].mes_ano} y ${cur[i].mes_ano}`);
  }
  const last = cur[cur.length - 1];
  latestSummary[crop] = last;
}
// los tres cultivos deben llegar a la misma fecha
const fechas = Object.values(latestSummary).map(r => r.fecha_info);
if (new Set(fechas).size > 1) err('Los cultivos terminan en fechas distintas: ' + JSON.stringify(Object.fromEntries(Object.entries(latestSummary).map(([k, r]) => [k, r.fecha_info]))));


// 2b) Alineación de semanas: para el mes de corte, cada campaña anterior debe tener el dato de la misma semana calendario
for (const crop of ['soja', 'maiz', 'trigo']) {
  const rows = E.raw[crop];
  const campañas = [...new Set(rows.map(r => r.campaña))].sort();
  const vig = campañas[campañas.length - 1];
  const cur = rows.filter(r => r.campaña === vig).sort((a, b) => new Date(a.fecha_info) - new Date(b.fecha_info)).pop();
  const curD = new Date(cur.fecha_info);
  rows.filter(r => r.campaña !== vig && r.mes_ano.split('-')[0] === cur.mes_ano.split('-')[0]).forEach(r => {
    const d = new Date(r.fecha_info);
    const diff = Math.abs((new Date(2000, d.getMonth(), d.getDate()) - new Date(2000, curD.getMonth(), curD.getDate())) / 864e5);
    if (diff > 4) warn(`ALINEACIÓN ${crop} ${r.campaña} ${r.mes_ano}: fecha ${r.fecha_info} está a ${diff} días de la fecha vigente ${cur.fecha_info} (revisar el bloque alineado del Excel)`);
  });
}

// 3) Liquidación
const liq = E.liq;
if (!liq || !liq.mensual || !liq.mensual['2026']) err('Liquidación: faltan datos de 2026');
else {
  const v = liq.mensual['2026'];
  const lastIdx = v.reduce((a, x, i) => x != null ? i : a, -1);
  if (v.slice(0, lastIdx + 1).some(x => x == null)) err('Liquidación 2026: hay meses vacíos antes del último cargado');
  const acc = liq.acumulado && liq.acumulado['2026'];
  const sum = v.slice(0, lastIdx + 1).reduce((a, x) => a + x, 0);
  if (acc != null && Math.abs(acc - sum) > Math.max(5, sum * 0.002)) err(`Liquidación: acumulado 2026 (${acc}) ≠ suma de meses (${sum.toFixed(1)})`);
  if (!/Enero-/.test(liq.acumuladoLabel || '')) warn('Liquidación: etiqueta de acumulado rara: ' + liq.acumuladoLabel);
  latestSummary.liq = { hasta: liq.cutoffMonthName, acumulado: acc };
}

// 4) Textos hardcodeados con meses viejos
const textos = [...html.matchAll(/Datos hasta [A-Za-z]+ 20\d\d/g)].map(x => x[0]);
if (new Set(textos).size > 1) warn('Hay textos "Datos hasta" distintos: ' + [...new Set(textos)].join(' | '));

function report() {
  console.log('\n=== Resumen de últimos datos ===');
  for (const [k, r] of Object.entries(latestSummary)) console.log(k, JSON.stringify(r).slice(0, 220));
  warns.forEach(w => console.log('WARN  ' + w));
  errors.forEach(e => console.log('ERROR ' + e));
  console.log(`\n${errors.length ? 'FALLÓ' : 'OK'} — ${errors.length} errores, ${warns.length} avisos`);
  process.exit(errors.length ? 1 : 0);
}
report();
