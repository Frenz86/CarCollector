'use strict';
const $ = id => document.getElementById(id);
const filterIds = ['q','brand','model','body_type','currency','country','era','year_from','year_to','price_range','price_min','price_max','from','to','priced','photo'];
const checkIds = ['priced','photo'];
const labels = {q:'Ricerca',brand:'Marca',model:'Modello',body_type:'Tipologia',currency:'Valuta',country:'Paese',era:'Decennio',year_from:'Anno da',year_to:'Anno a',price_range:'Fascia prezzo',price_min:'Prezzo min',price_max:'Prezzo max',from:'Dal',to:'Al',priced:'Solo con prezzo',photo:'Solo con foto'};
let current = null, page = 1, allGroups = false, requestId = 0, activeCarIndex = -1, slideshowTimer = null, carNavigationInProgress = false;
const saved = (() => {try {return JSON.parse(localStorage.getItem('scrapecar-filters') || '{}');} catch {return {};}})();
let selectedBrands = Array.isArray(saved.brand) ? saved.brand : (saved.brand ? [saved.brand] : []);
let selectedModels = Array.isArray(saved.model) ? saved.model : (saved.model ? [saved.model] : []);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n = value => new Intl.NumberFormat('it-IT', {maximumFractionDigits:0}).format(value ?? 0);
function money(value, currency) {
  if (value == null || !currency || currency === 'N/D') return '—';
  try {return new Intl.NumberFormat('it-IT', {style:'currency', currency, maximumFractionDigits:0}).format(value);}
  catch {return `${n(value)} ${currency}`;}
}
function date(value) {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? value + 'T12:00:00' : value);
  return Number.isNaN(+d) ? '—' : d.toLocaleDateString('it-IT');
}
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6500);
}
async function api(path, options = {}) {
  const response = await fetch(path, {...options, headers:{...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}});
  if (!response.ok) {let body; try {body = await response.json();} catch {} throw Error(body?.error || 'Impossibile contattare il server.');}
  return response.json();
}
function params() {
  const p = new URLSearchParams();
  for (const id of filterIds) {
    if (id === 'brand' || id === 'model') {
      const selected = id === 'brand' ? selectedBrands : selectedModels;
      for (const value of selected) p.append(id, value);
      continue;
    }
    const value = checkIds.includes(id) ? ($(id).checked ? '1' : '') : $(id).value.trim();
    if (value) p.set(id, value);
  }
  const [sort, direction] = $('sort').value.split(':');
  p.set('dimension', $('dimension').value); p.set('page', page); p.set('sort', sort); p.set('direction', direction);
  p.set('trend_dimension', $('trend-dimension').value); p.set('trend_currency', $('trend-currency').value);
  return p;
}
function fillFacets(facets) {
  const placeholders = {model:'Tutti i modelli', body_type:'Tutte le tipologie', currency:'Tutte le valute', country:'Tutti i paesi', era:'Tutti gli anni'};
  for (const [key, values] of Object.entries(facets)) {
    if (key === 'brand' || key === 'model') continue;
    const select = $(key), value = select.value || (current ? '' : saved[key] || '');
    select.replaceChildren(new Option(placeholders[key], ''));
    for (const {value:v, count} of values) {
      const name = key === 'era' && v !== 'Sconosciuta' ? `Anni ${v}` : v;
      const option = new Option(`${name} (${n(count)})`, v);
      if (!count) option.disabled = v !== value;
      select.add(option);
    }
    if ([...select.options].some(o => o.value === value)) select.value = value;
  }
  renderBrandOptions(facets.brand);
  renderModelOptions(facets.model);
}
function renderBrandOptions(facets = []) {
  const options = new Map(facets.map(item => [item.value,item.count]));
  for (const brand of selectedBrands) if (!options.has(brand)) options.set(brand,0);
  const query = $('brand-search').value.trim().toLocaleLowerCase('it');
  $('brand-options-list').innerHTML = [...options].sort((a,b) => a[0].localeCompare(b[0],'it'))
    .filter(([name]) => name.toLocaleLowerCase('it').includes(query))
    .map(([name,count]) => `<label class="brand-option"><input type="checkbox" value="${escapeHTML(name)}" ${selectedBrands.includes(name) ? 'checked' : ''}><span>${escapeHTML(name)}</span><small>${n(count)}</small></label>`).join('')
    || '<p class="brand-no-results">Nessuna marca trovata.</p>';
  const button = $('brand-toggle');
  button.innerHTML = `${selectedBrands.length ? `${selectedBrands.length} ${selectedBrands.length === 1 ? 'marca' : 'marche'} selezionat${selectedBrands.length === 1 ? 'a' : 'e'}` : 'Tutte le marche'} <b>⌄</b>`;
  button.setAttribute('aria-label',selectedBrands.length ? `Marche selezionate: ${selectedBrands.join(', ')}` : 'Tutte le marche');
}
function renderModelOptions(facets = []) {
  const options = new Map(facets.map(item => [item.value,item.count]));
  for (const model of selectedModels) if (!options.has(model)) options.set(model,0);
  const query = $('model-search').value.trim().toLocaleLowerCase('it');
  $('model-options-list').innerHTML = [...options].sort((a,b) => a[0].localeCompare(b[0],'it'))
    .filter(([name]) => name.toLocaleLowerCase('it').includes(query))
    .map(([name,count]) => `<label class="brand-option"><input type="checkbox" value="${escapeHTML(name)}" ${selectedModels.includes(name) ? 'checked' : ''}><span>${escapeHTML(name)}</span><small>${n(count)}</small></label>`).join('')
    || '<p class="brand-no-results">Nessun modello trovato.</p>';
  const button = $('model-toggle');
  button.innerHTML = `${selectedModels.length ? `${selectedModels.length} ${selectedModels.length === 1 ? 'modello selezionato' : 'modelli selezionati'}` : 'Tutti i modelli'} <b>⌄</b>`;
  button.setAttribute('aria-label',selectedModels.length ? `Modelli selezionati: ${selectedModels.join(', ')}` : 'Tutti i modelli');
}
function renderChips() {
  const chips = [];
  for (const id of filterIds) {
    if (id === 'brand') {
      for (const brand of selectedBrands) chips.push(`<button class="chip" data-clear="brand" data-value="${escapeHTML(brand)}" title="Rimuovi filtro marca">${escapeHTML(brand)} <b>×</b></button>`);
      continue;
    }
    if (id === 'model') {
      for (const model of selectedModels) chips.push(`<button class="chip" data-clear="model" data-value="${escapeHTML(model)}" title="Rimuovi filtro modello">${escapeHTML(model)} <b>×</b></button>`);
      continue;
    }
    const el = $(id);
    if (checkIds.includes(id) ? !el.checked : !el.value.trim()) continue;
    const text = checkIds.includes(id) ? labels[id] : `${labels[id]}: ${el.tagName === 'SELECT' ? el.selectedOptions[0].textContent.replace(/ \(\d[\d.]*\)$/, '') : el.value}`;
    chips.push(`<button class="chip" data-clear="${id}" title="Rimuovi filtro">${escapeHTML(text)} <b>×</b></button>`);
  }
  $('chips').innerHTML = chips.join('');
  $('chips').hidden = !chips.length;
  $('reset').disabled = !chips.length;
  const extra = ['country','era','year_from','year_to','price_range','price_min','price_max','from','to','priced','photo'].filter(id => checkIds.includes(id) ? $(id).checked : $(id).value).length;
  $('more-filters').textContent = extra ? `☷ Altri filtri (${extra})` : '☷ Altri filtri';
}
function renderStatus(job) {
  $('job-badge').textContent = 'ARCHIVIO';
  $('job-message').textContent = job.message || 'Snapshot dell’archivio Collecting Cars';
  $('progress').style.width = `${job.total_pages ? Math.min(100,100 * (job.current_page || 0) / job.total_pages) : 0}%`;
}
function render() {
  const {summary:s, job, seed} = current;
  renderChips();
  fillTrendCurrencies(s);
  $('nav-count').textContent = n(current.archive_total);
  renderStatus(job);
  const expected = job.expected || seed?.expected;
  $('coverage').textContent = `${n(current.archive_total)} auto archiviate${expected ? ` / ${n(expected)} indicate dal sito` : ''} · ${job.state === 'complete' ? 'Scansione delle pagine conclusa' : 'Archivio parziale'} · Guida a sinistra`;
  $('kpi-count').textContent = n(s.count);
  $('kpi-brands').textContent = `${n(s.brands)} marche · ${n(s.missing)} prezzi mancanti`;
  const currencies = s.currencies.filter(c => c.priced > 0 && c.currency !== 'N/D');
  const priced = currencies.length === 1 ? currencies[0] : null;
  $('kpi-median').textContent = priced ? money(priced.median,priced.currency) : '—';
  $('kpi-mean').textContent = priced ? money(priced.mean,priced.currency) : '—';
  $('kpi-median-note').textContent = priced ? `${n(priced.priced)} prezzi osservati in ${priced.currency}${priced.priced < 5 ? ' · campione piccolo' : ''}` : (currencies.length > 1 ? `${currencies.length} valute: selezionane una per confrontarle` : 'Nessun prezzo disponibile nei filtri');
  $('kpi-range').textContent = priced ? `${money(priced.minimum,priced.currency)} — ${money(priced.maximum,priced.currency)}` : 'Valute originali, senza conversioni';
  const percent = s.count ? Math.round(s.priced / s.count * 100) : 0;
  $('kpi-coverage').textContent = `${percent}%`;
  $('kpi-coverage-note').textContent = `${n(s.priced)} prezzi osservati su ${n(s.count)} auto`;
  $('donut-value').textContent = `${percent}%`;
  $('donut').style.background = `conic-gradient(#a5bb76 0% ${percent}%,#edf1e7 ${percent}% 100%)`;
  $('legend-priced').textContent = n(s.priced); $('legend-missing').textContent = n(s.missing);
  const dim = $('dimension').value;
  const names = {brand:'Le marche più presenti', model:'I modelli più presenti', body_type:'Le tipologie più presenti', era:'Le epoche più presenti', country:'I paesi più presenti'};
  const selectedBrand = selectedBrands.length === 1 ? selectedBrands[0] : '';
  const showingModels = dim === 'brand' && Boolean(selectedBrand);
  $('chart-title').textContent = showingModels ? `Modelli ${selectedBrand}` : names[dim];
  $('chart-back').hidden = !showingModels;
  $('chart-help').textContent = showingModels ? 'Clicca un modello per filtrare le vendite e confrontare il suo andamento nel tempo.' : dim === 'brand' ? 'Clicca una marca per esplorare i suoi modelli.' : 'Seleziona una barra per esplorare le vendite del gruppo.';
  const counts = new Map();
  const chartGroups = showingModels ? current.facets.model.map(item => ({name:item.value,count:item.count})) : s.groups;
  for (const g of chartGroups) counts.set(g.name,(counts.get(g.name) || 0) + g.count);
  const top = [...counts].sort((a,b) => b[1]-a[1]).slice(0,8), max = top[0]?.[1] || 1;
  $('brand-chart').innerHTML = top.length ? top.map(([name,count]) => `<button class="bar-row" data-group="${escapeHTML(name)}" title="Filtra ${escapeHTML(name)}"><span class="bar-name">${escapeHTML(dim === 'era' ? 'Anni '+name : name)}</span><span class="bar-track"><span class="bar-fill" style="width:${count/max*100}%;display:block"></span></span><span class="bar-value">${n(count)}</span></button>`).join('') : '<div class="empty">Nessuna vendita con questi filtri.<br>Prova ad ampliare la ricerca.</div>';
  const groups = allGroups ? s.groups : s.groups.slice(0,10);
  $('group-rows').innerHTML = groups.length ? groups.map(g => `<tr><td>${escapeHTML(g.name)}${g.priced > 0 && g.priced < 5 ? '<span class="sample-tag">n &lt; 5</span>' : ''}</td><td>${escapeHTML(g.currency)}</td><td>${n(g.count)}</td><td>${n(g.priced)}</td><td>${money(g.median,g.currency)}</td><td>${money(g.mean,g.currency)}</td><td>${g.q25 == null ? '—' : money(g.q25,g.currency)+' – '+money(g.q75,g.currency)}</td><td>${g.minimum == null ? '—' : money(g.minimum,g.currency)+' / '+money(g.maximum,g.currency)}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">Nessun dato corrisponde ai filtri.</td></tr>';
  $('groups-more').hidden = s.groups.length <= 10;
  $('groups-more').textContent = allGroups ? 'Mostra meno gruppi' : `Mostra tutti i ${n(s.groups.length)} gruppi`;
  $('table-count').textContent = n(s.count);
  $('car-rows').innerHTML = current.rows.length ? current.rows.map(r => `<tr><td><div class="car-cell">${r.image_url ? `<img class="car-image" src="${escapeHTML(r.image_url.replace(/([?&])w=\d+/,'$1w=240'))}" alt="${escapeHTML(r.title)}" loading="lazy" referrerpolicy="no-referrer" data-fallback>` : '<div class="car-image"></div>'}<div><button class="car-name" data-car="${escapeHTML(r.id)}" title="${escapeHTML(r.title)}">${escapeHTML(r.title)}</button><div class="car-sub">${escapeHTML(r.brand)} <span>·</span> ${escapeHTML(r.model)} <span>·</span> LHD</div></div></div></td><td><span class="type-tag">${escapeHTML(r.body_type)}</span></td><td>${date(r.sold_date)}</td><td>${escapeHTML(r.location || r.country || '—')}<div class="car-sub">${escapeHTML(r.country)}</div></td><td>${r.price != null ? `<span class="price">${money(r.price,r.currency)}</span>${r.price_status === 'previously_visible' ? `<small class="price-historic">Osservato il ${date(r.price_observed_at)}</small>` : ''}` : `<span class="locked-price">${r.price_status === 'login_required' ? '◈ Accesso richiesto' : 'Non disponibile'}</span>`}</td><td><a class="external-link" href="${escapeHTML(r.url)}" target="_blank" rel="noreferrer" aria-label="Apri ${escapeHTML(r.title)} su Collecting Cars">↗</a></td></tr>`).join('') : '<tr><td colspan="6" class="empty">Non ci sono auto con questi filtri.<br>Azzera i filtri oppure avvia la prima raccolta.</td></tr>';
  $('page-info').textContent = `Pagina ${current.page} di ${current.pages} · ${n(s.count)} risultati`;
  $('prev').disabled = current.page <= 1; $('next').disabled = current.page >= current.pages;
  $('slideshow-open').disabled = !current.rows.length;
  $('price-sort-hint').hidden = !$('sort').value.startsWith('price:') || Boolean($('currency').value);
  $('price_range').disabled = !$('currency').value;
  $('price-range-hint').hidden = Boolean($('currency').value);
  renderPriceTrend();
  $('last-update').textContent = current.updated_at ? `Ultima osservazione · ${date(current.updated_at)}` : 'Dati locali · Collecting Cars';
}
function fillTrendCurrencies(summary) {
  const select = $('trend-currency');
  const currencies = summary.currencies.filter(c => c.priced > 0 && c.currency && c.currency !== 'N/D')
    .sort((a,b) => b.priced - a.priced || a.currency.localeCompare(b.currency));
  const preferred = select.value || saved.trend_currency || $('currency').value;
  select.replaceChildren(new Option(currencies.length ? 'Seleziona valuta' : 'Nessun prezzo', ''));
  for (const {currency,priced} of currencies) select.add(new Option(`${currency} · ${n(priced)} prezzi`,currency));
  if (currencies.some(c => c.currency === preferred)) select.value = preferred;
  else if (currencies.some(c => c.currency === $('currency').value)) select.value = $('currency').value;
  else if (currencies.length) select.value = currencies[0].currency;
}
function renderPriceTrend() {
  const currency = $('trend-currency').value, dimension = $('trend-dimension').value;
  const brand = selectedBrands.length === 1 ? selectedBrands[0] : '';
  const groups = new Map();
  for (const point of current.summary.price_trends) {
    if (point.currency !== currency) continue;
    let group = groups.get(point.series);
    if (!group) {
      const name = dimension === 'model' && !brand ? `${point.brand} · ${point.model}` : point.name;
      group = {name,points:new Map(),count:0};
      groups.set(point.series,group);
    }
    group.points.set(point.month,point);
    group.count += point.count;
  }
  const series = [...groups.values()].sort((a,b) => b.count-a.count || a.name.localeCompare(b.name)).slice(0,5);
  const note = dimension === 'model' ? (brand ? `i modelli di ${brand}` : 'i modelli, distinti per marca') : 'le marche';
  if (!currency || !series.length) {
    $('trend-note').textContent = currency ? `Nessun prezzo in ${currency} per i filtri selezionati.` : 'Seleziona una valuta con prezzi disponibili per vedere l’andamento.';
    $('price-trend-chart').innerHTML = '<div class="empty">Servono prezzi e date di vendita per tracciare l’andamento.</div>';
    $('trend-legend').replaceChildren();
    return;
  }
  const months = [...new Set(series.flatMap(group => [...group.points.keys()]))].sort();
  const values = series.flatMap(group => [...group.points.values()].map(point => point.median));
  let minimum = Math.min(...values), maximum = Math.max(...values);
  if (minimum === maximum) {const padding = Math.max(1,maximum * .08); minimum = Math.max(0,minimum-padding); maximum += padding;}
  const left=78, right=790, top=20, bottom=224, width=right-left, height=bottom-top;
  const x = index => months.length === 1 ? left+width/2 : left+index*width/(months.length-1);
  const y = value => bottom-(value-minimum)*height/(maximum-minimum);
  const colors=['#547449','#c1813b','#637f9d','#9b6b8c','#829348'];
  const grid=Array.from({length:5},(_,i) => {
    const value=maximum-(maximum-minimum)*i/4, yPos=top+height*i/4;
    return `<line class="trend-grid" x1="${left}" y1="${yPos}" x2="${right}" y2="${yPos}"></line><text class="trend-axis-label" x="${left-10}" y="${yPos+4}" text-anchor="end">${escapeHTML(money(value,currency))}</text>`;
  }).join('');
  const monthLabels=months.map((month,index) => {
    const interval=Math.max(1,Math.ceil(months.length/8));
    if (index!==0 && index!==months.length-1 && index%interval!==0) return '';
    const label=new Date(`${month}-01T12:00:00`).toLocaleDateString('it-IT',{month:'short',year:'2-digit'});
    return `<text class="trend-axis-label" x="${x(index)}" y="${bottom+23}" text-anchor="middle">${escapeHTML(label)}</text>`;
  }).join('');
  const lines=series.map((group,index) => {
    const points=months.flatMap((month,monthIndex) => {
      const point=group.points.get(month);
      return point ? [{...point,x:x(monthIndex),y:y(point.median)}] : [];
    });
    const path=points.map((point,i) => `${i?'L':'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const dots=points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="4" fill="${colors[index]}"><title>${escapeHTML(`${group.name} · ${point.month} · ${money(point.median,currency)} · ${n(point.count)} auto`)}</title></circle>`).join('');
    return `<path class="trend-line" d="${path}" stroke="${colors[index]}"></path>${dots}`;
  }).join('');
  $('price-trend-chart').innerHTML=`<svg viewBox="0 0 820 270" role="img" aria-label="Prezzo mediano mensile per ${escapeHTML(note)} in ${escapeHTML(currency)}">${grid}${monthLabels}${lines}</svg>`;
  $('trend-legend').innerHTML=series.map((group,index) => `<span><i style="background:${colors[index]}"></i>${escapeHTML(group.name)} <b>${n(group.count)}</b></span>`).join('');
  $('trend-note').textContent=`Mediana mensile per ${note} in ${currency} · ${n(values.length ? series.reduce((sum,group)=>sum+group.count,0) : 0)} prezzi osservati. Le linee mostrano fino a 5 gruppi; passa sui punti per vedere il campione mensile.`;
}
async function refresh() {
  const id = ++requestId;
  try {
    const data = await api('/api/view?'+params());
    if (id !== requestId) return false;
    fillFacets(data.facets); current = data; page = data.page; render();
    try {localStorage.setItem('scrapecar-filters',JSON.stringify({...Object.fromEntries(params()),brand:selectedBrands,model:selectedModels}));} catch {}
    return true;
  } catch (error) {toast(error.message); return false;}
}
async function action(path,body={}) {
  try {await api(path,{method:'POST',body:JSON.stringify(body)}); await refresh();}
  catch (error) {toast(error.message);}
}
function filtered() {page = 1; allGroups = false; refresh();}
for (const id of filterIds) {
  if (id === 'brand' || id === 'model') continue;
  if (id === 'q') {
    $(id).value = saved[id] || '';
    $(id).addEventListener('input',() => {clearTimeout(filtered.timer); filtered.timer = setTimeout(filtered,250);});
  } else {
    if (checkIds.includes(id)) $(id).checked = saved[id] === '1';
    else if (['from','to','year_from','year_to','price_min','price_max'].includes(id)) $(id).value = saved[id] || '';
    else if (id === 'price_range') $(id).value = saved[id] || '';
    const typed = ['year_from','year_to','price_min','price_max'].includes(id);
    $(id).addEventListener(typed ? 'input' : 'change',() => {
      if (id === 'price_range' && $(id).value) $('price_min').value = $('price_max').value = '';
      if (id === 'price_min' || id === 'price_max') $('price_range').value = '';
      if (id === 'currency' && !$(id).value) $('price_range').value = '';
      clearTimeout(filtered.timer); filtered.timer = setTimeout(filtered,typed ? 400 : 0);
    });
  }
}
$('brand-search').addEventListener('input',() => renderBrandOptions(current?.facets.brand || []));
$('brand-options-list').addEventListener('change',event => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  selectedBrands = checkbox.checked
    ? [...selectedBrands,checkbox.value]
    : selectedBrands.filter(brand => brand !== checkbox.value);
  selectedModels = [];
  $('trend-dimension').value = selectedBrands.length === 1 ? 'model' : 'brand';
  renderBrandOptions(current?.facets.brand || []);
  renderModelOptions(current?.facets.model || []);
  filtered();
});
$('brand-clear').addEventListener('click',() => {
  selectedBrands = [];
  selectedModels = [];
  $('trend-dimension').value = 'brand';
  renderBrandOptions(current?.facets.brand || []);
  renderModelOptions(current?.facets.model || []);
  filtered();
});
function closeFilterOptions() {
  for (const id of ['brand','model']) {
    $(`${id}-options`).hidden = true;
    $(`${id}-toggle`).setAttribute('aria-expanded','false');
  }
}
for (const id of ['brand','model']) {
  $(`${id}-toggle`).addEventListener('click',() => {
    const options = $(`${id}-options`);
    const open = options.hidden;
    closeFilterOptions();
    options.hidden = !open;
    $(`${id}-toggle`).setAttribute('aria-expanded',open);
    if (open) $(`${id}-search`).focus();
  });
}
$('model-search').addEventListener('input',() => renderModelOptions(current?.facets.model || []));
$('model-options-list').addEventListener('change',event => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  selectedModels = checkbox.checked
    ? [...selectedModels,checkbox.value]
    : selectedModels.filter(model => model !== checkbox.value);
  $('trend-dimension').value = 'model';
  renderModelOptions(current?.facets.model || []);
  filtered();
});
$('model-clear').addEventListener('click',() => {
  selectedModels = [];
  renderModelOptions(current?.facets.model || []);
  filtered();
});
document.addEventListener('click',event => {
  if (!event.target.closest('.brand-filter')) closeFilterOptions();
});
document.addEventListener('keydown',event => {
  const open = ['brand','model'].find(id => !$(`${id}-options`).hidden);
  if (event.key === 'Escape' && open) {
    closeFilterOptions();
    $(`${open}-toggle`).focus();
  }
});
$('dimension').addEventListener('change',filtered);
$('trend-dimension').addEventListener('change',filtered);
$('trend-currency').addEventListener('change',filtered);
$('sort').addEventListener('change',filtered);
function clearFilter(id) {
  if (id === 'brand') {
    selectedBrands = [];
    renderBrandOptions(current?.facets.brand || []);
  } else if (id === 'model') {
    selectedModels = [];
    renderModelOptions(current?.facets.model || []);
  } else if (checkIds.includes(id)) $(id).checked = false;
  else $(id).value = '';
}
$('reset').addEventListener('click',() => {filterIds.forEach(clearFilter); filtered();});
$('chips').addEventListener('click',event => {
  const b = event.target.closest('[data-clear]'); if (!b) return;
  if (b.dataset.clear === 'brand') {
    selectedBrands = selectedBrands.filter(brand => brand !== b.dataset.value);
    selectedModels = [];
    $('trend-dimension').value = selectedBrands.length === 1 ? 'model' : 'brand';
    renderBrandOptions(current?.facets.brand || []);
    renderModelOptions(current?.facets.model || []);
  } else if (b.dataset.clear === 'model') {
    selectedModels = selectedModels.filter(model => model !== b.dataset.value);
    renderModelOptions(current?.facets.model || []);
  } else clearFilter(b.dataset.clear);
  filtered();
});
document.addEventListener('error',event => {if (event.target.matches?.('img[data-fallback]')) {const d = document.createElement('div'); d.className = event.target.className; event.target.replaceWith(d);}},true);
$('more-filters').addEventListener('click',() => {$('extra-filters').hidden = !$('extra-filters').hidden; $('more-filters').setAttribute('aria-expanded',!$('extra-filters').hidden);});
$('prev').addEventListener('click',() => {page--; refresh();});
$('next').addEventListener('click',() => {page++; refresh();});
$('groups-more').addEventListener('click',() => {allGroups = !allGroups; render();});
$('chart-back').addEventListener('click',() => {
  selectedBrands = [];
  selectedModels = [];
  $('trend-dimension').value = 'brand';
  renderBrandOptions(current?.facets.brand || []);
  renderModelOptions(current?.facets.model || []);
  filtered();
});
$('brand-chart').addEventListener('click',event => {
  const b = event.target.closest('[data-group]'); if (!b) return;
  const dim = $('dimension').value;
  if (dim === 'brand' && selectedBrands.length === 1) {
    selectedModels = [b.dataset.group]; $('trend-dimension').value='model';
  } else if (dim === 'model') {
    const brand=[...current.facets.brand].map(item=>item.value).sort((a,b)=>b.length-a.length).find(brand=>b.dataset.group.startsWith(brand+' '));
    if (brand) {
      selectedBrands = [brand];
      selectedModels = [b.dataset.group.slice(brand.length+1)];
      renderBrandOptions(current?.facets.brand || []);
      renderModelOptions(current?.facets.model || []);
    }
    else {$('q').value=b.dataset.group;}
    $('trend-dimension').value='model';
  } else if (dim === 'brand') {
    selectedBrands = [b.dataset.group]; selectedModels = []; $('trend-dimension').value='model';
    renderBrandOptions(current?.facets.brand || []);
    renderModelOptions(current?.facets.model || []);
  } else $(dim).value=b.dataset.group;
  filtered();
});
$('export').addEventListener('click',async () => {
  try {
    const response = await fetch('/api/export?'+params(),);
    if (!response.ok) throw Error('Esportazione non riuscita.');
    const url = URL.createObjectURL(await response.blob()), a = document.createElement('a');
    a.href=url; a.download='collectingcars-vendute.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    toast('CSV esportato con i filtri correnti.');
  } catch (error) {toast(error.message);}
});
for (const button of document.querySelectorAll('[data-scroll]')) button.addEventListener('click',() => {
  $(button.dataset.scroll).scrollIntoView({behavior:'smooth'});
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active',b === button));
});
for (const b of document.querySelectorAll('.dialog-close')) b.addEventListener('click',() => b.closest('dialog').close());
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click',e => {if (e.target === d) {const r=d.getBoundingClientRect(); if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});
$('method-open').addEventListener('click',() => $('method-dialog').showModal());
function cost() {
  const read = id => Math.max(0,Number($(id).value) || 0);
  const base=read('cost-base'), fee=base*read('cost-fee')/100;
  const extras=read('cost-transport')+read('cost-tax')+read('cost-other');
  $('cost-total').textContent=money(base+fee+extras,$('cost-currency').value);
  $('cost-breakdown').textContent=`Prezzo ${money(base,$('cost-currency').value)} + commissione ${money(fee,$('cost-currency').value)} + spese ${money(extras,$('cost-currency').value)}`;
}
function openCost(car) {
  $('cost-car').textContent=car?.title || 'Inserisci il prezzo o seleziona un’auto dall’archivio.';
  $('cost-base').value=car?.price ?? 0;
  if (car?.currency) {
    if (![...$('cost-currency').options].some(o => o.value === car.currency)) $('cost-currency').add(new Option(car.currency,car.currency));
    $('cost-currency').value=car.currency;
  }
  cost(); $('cost-dialog').showModal();
}
$('cost-open').addEventListener('click',() => openCost(null));
for (const input of document.querySelectorAll('#cost-dialog input,#cost-dialog select')) input.addEventListener('input',cost);
function stopSlideshow() {
  clearInterval(slideshowTimer);
  slideshowTimer = null;
}
function canNavigateCars() {
  return current?.summary.count > 1;
}
async function moveCar(direction) {
  if (!current?.rows.length || carNavigationInProgress) return;
  const index = activeCarIndex + direction;
  if (index >= 0 && index < current.rows.length) {
    openCar(index);
    return;
  }
  const previousPage = page;
  page = page + direction;
  if (page < 1) page = current.pages;
  else if (page > current.pages) page = 1;
  carNavigationInProgress = true;
  try {
    if (await refresh() && current.rows.length) {
      openCar(direction > 0 ? 0 : current.rows.length - 1);
    } else {
      page = previousPage;
      stopSlideshow();
    }
  } finally {
    carNavigationInProgress = false;
  }
}
function openCar(index) {
  if (!current?.rows.length) return;
  activeCarIndex = (index + current.rows.length) % current.rows.length;
  const r = current.rows[activeCarIndex];
  $('detail-title').textContent = r.title;
  const types=['Non classificata','Coupé','Cabriolet / Roadster','Station wagon','SUV / Fuoristrada','Berlina','Berlina compatta','Da competizione'];
  $('detail-content').innerHTML = `<div class="slideshow-controls"><button class="button secondary small" id="car-prev" type="button" ${!canNavigateCars() ? 'disabled' : ''}>← Precedente</button><span id="car-position" aria-live="polite">Auto ${activeCarIndex + 1} di ${current.rows.length} · pagina ${current.page}</span><div><button class="button secondary small" id="car-play" type="button" ${!canNavigateCars() ? 'disabled title="Servono almeno due auto"' : ''}>${slideshowTimer ? 'Ⅱ Pausa' : '▶ Avvia slideshow'}</button><button class="button secondary small" id="car-next" type="button" ${!canNavigateCars() ? 'disabled' : ''}>Successiva →</button></div></div>${r.image_url ? `<img class="detail-image" src="${escapeHTML(r.image_url.replace(/([?&])w=\\d+/,'$1w=1200'))}" alt="${escapeHTML(r.title)}" referrerpolicy="no-referrer" data-fallback>` : '<div class="detail-image-placeholder">Foto non disponibile</div>'}<div class="detail-grid"><div><span>PREZZO DI VENDITA</span><strong>${r.price == null ? (r.price_status === 'login_required' ? 'Accesso richiesto sul sito' : 'Non disponibile') : money(r.price,r.currency)}</strong></div><div><span>DATA DI VENDITA</span><strong>${date(r.sold_date)}</strong></div><div><span>MARCA / MODELLO</span><strong>${escapeHTML(r.brand)} / ${escapeHTML(r.model)}</strong></div><div><span>PAESE / LOCALITÀ</span><strong>${escapeHTML(r.country)} · ${escapeHTML(r.location)}</strong></div><div><span>CLASSIFICAZIONE</span><strong>${escapeHTML(r.classification)}</strong></div><div><span>PREZZO OSSERVATO IL</span><strong>${date(r.price_observed_at)}</strong></div></div><div class="detail-actions"><a class="button primary" href="${escapeHTML(r.url)}" target="_blank" rel="noreferrer">Annuncio originale ↗</a><button class="button secondary" id="detail-cost" type="button">Simula costi</button></div>`;
  $('car-prev').addEventListener('click', () => moveCar(-1));
  $('car-next').addEventListener('click', () => moveCar(1));
  $('car-play').addEventListener('click', () => {
    if (slideshowTimer) stopSlideshow();
    else if (canNavigateCars()) slideshowTimer = setInterval(() => moveCar(1), 5000);
    $('car-play').textContent = slideshowTimer ? 'Ⅱ Pausa' : '▶ Avvia slideshow';
  });
  $('detail-cost').addEventListener('click',() => {stopSlideshow(); $('car-dialog').close(); openCost(r);});
  if (!$('car-dialog').open) $('car-dialog').showModal();
}
$('car-rows').addEventListener('click',event => {
  const button=event.target.closest('[data-car]'); if (!button) return;
  const index=current.rows.findIndex(r => r.id === button.dataset.car); if (index < 0) return;
  openCar(index);
});
$('slideshow-open').addEventListener('click',() => {
  $('archive').scrollIntoView({behavior:'smooth',block:'start'});
  openCar(0);
});
$('car-dialog').addEventListener('close',stopSlideshow);
document.addEventListener('keydown',event => {
  if (!$('car-dialog').open || event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
  if (event.key === 'ArrowLeft') {event.preventDefault(); moveCar(-1);}
  if (event.key === 'ArrowRight') {event.preventDefault(); moveCar(1);}
});
(async () => {
  try {
    const data=await api('/api/view'); fillFacets(data.facets);
    if (saved.dimension && [...$('dimension').options].some(o=>o.value===saved.dimension)) $('dimension').value=saved.dimension;
    if (saved.trend_dimension && [...$('trend-dimension').options].some(o=>o.value===saved.trend_dimension)) $('trend-dimension').value=saved.trend_dimension;
    await refresh();
  } catch (error) {toast(error.message);}
})();
