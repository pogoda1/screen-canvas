import assert from 'node:assert/strict';
import process from 'node:process';
import { preparePackagedLaunch } from './packaged/launcher.mjs';
import test from 'node:test';
import { launchCanvas, pick, waitGraph, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('the overview has no edge overlays and selection lists only complete adjacent connections', { timeout: 35_000 }, async t => {
  const condition = 'When the selected local fixture is in the editable state and its display settings have been loaded';
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      actions: [
        {id:'arrive',source:'route:/',target:'route:/focus',label:'Enter from the landing page',
          steps:[{type:'click',selector:'#focus'}],expectedPath:'/focus'},
        {id:'details-member',source:'route:/focus',target:'route:/detail',label:'Open the complete record description',
          condition:${JSON.stringify(condition)},role:'member',
          steps:[{type:'fill',selector:'#query',value:'Sample local value'},{type:'click',selector:'#detail'}]},
        {id:'details-guest',source:'route:/focus',target:'route:/detail',label:'Open as a guest',
          condition:'Guest without saved settings',role:'guest',steps:[{type:'click',selector:'#missing'}]},
        {id:'self',source:'route:/focus',target:'route:/focus',label:'Refresh the selected card',
          steps:[{type:'click',selector:'#self'}]},
        {id:'unrelated',source:'route:/',target:'route:/detail',label:'Unrelated action',
          steps:[{type:'click',selector:'#other'}]}
      ]
    };`,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route, useNavigate} from 'react-router-dom';
      function Entry() {
        const navigate = useNavigate();
        return <main><h1>Landing</h1>
          <button id="focus" onClick={() => navigate('/focus')}>Focus</button>
          <button id="other" onClick={() => navigate('/detail')}>Other</button>
        </main>;
      }
      function Focus() {
        const navigate = useNavigate();
        return <main><h1>Focused form</h1><input id="query" aria-label="Search"/>
          <button id="detail" onClick={() => navigate('/detail')}>Details</button>
          <button id="self" onClick={() => navigate('/focus')}>Refresh</button>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<Entry/>}/>
        <Route path="/focus" element={<Focus/>}/>
        <Route path="/detail" element={<h1>Record details</h1>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const card = shell.getByRole('button', { name: '/focus', exact: true });
  await card.waitFor();
  const stage = shell.locator('#graph-stage');
  const layer = stage.locator('#connections');
  const lines = layer.locator('g path');
  assert.equal(await layer.isVisible(), false);
  assert.equal(await lines.count(), 0);
  assert.equal(await stage.locator('.edge-label, #edge-labels').count(), 0);
  assert.equal(await shell.getByRole('heading', { name: 'Связи экрана' }).count(), 0);
  await shell.getByRole('button', { name: 'Увеличить масштаб' }).click();
  const transform = await stage.getAttribute('style');
  await shell.locator('#graph').press('ArrowRight');
  assert.notEqual(await stage.getAttribute('style'), transform);
  await card.click();
  await waitGuest(electron, "document.querySelector('h1')?.textContent === 'Focused form'");
  const incoming = shell.locator('.edge-group').filter({ has: shell.getByRole('heading', { name: 'Входящие' }) });
  const outgoing = shell.locator('.edge-group').filter({ has: shell.getByRole('heading', { name: 'Исходящие' }) });
  await incoming.getByText('Enter from the landing page').waitFor();
  await outgoing.getByText('Условие · ' + condition).waitFor();
  const ids = group => group.locator('li').evaluateAll(elements => elements.map(element => element.dataset.edgeId));
  const { edges } = await waitGraph(shell);
  const relation = key => edges.filter(edge => edge[key] === 'route:/focus').map(edge => edge.id).sort();
  assert.deepEqual((await ids(incoming)).sort(), relation('target'));
  assert.deepEqual((await ids(outgoing)).sort(), relation('source'));
  assert.ok(relation('target').includes('self') && relation('source').includes('self'));
  assert.ok(relation('source').includes('details-guest') && relation('source').includes('details-member'));
  await outgoing.getByText('Роль · member').waitFor();
  await outgoing.getByText('Значение · "Sample local value"').waitFor();
  assert.equal(await shell.getByText('Unrelated action', { exact: true }).count(), 0);
  await incoming.locator('[data-edge-id="arrive"]').getByText('Подтверждено').waitFor();
  await outgoing.locator('[data-edge-id="details-guest"]').getByText('The action control is unavailable').waitFor();
  assert.equal(await card.getAttribute('aria-pressed'), 'true');
  async function checkSegments(selected) {
    const expected = edges.flatMap(edge => {
      const target = edge.evidence.status === 'confirmed' ? edge.target :
        edge.evidence.transitionObserved && edge.evidence.actualTarget;
      return target && (edge.source === selected || target === selected) ? [edge.id] : [];
    }).sort();
    assert.equal(await layer.isVisible(), true);
    assert.deepEqual(await lines.evaluateAll(paths => paths.map(item => item.dataset.edgeId).sort()), expected);
    assert.equal(await layer.evaluate(item => getComputedStyle(item).pointerEvents), 'none');
    assert.ok(await lines.evaluateAll(paths => paths.every(item =>
      item.getTotalLength() > 0 && getComputedStyle(item).stroke !== 'none' &&
      item.getAttribute('marker-end')?.startsWith('url(#arrow-'))));
    assert.equal(await stage.locator('.edge-label, #edge-labels, #connections text').count(), 0);
  }
  await checkSegments('route:/focus');
  const selectedTransform = await stage.getAttribute('style');
  await shell.getByRole('button', { name: '/', exact: true }).click();
  await waitGuest(electron, "document.querySelector('h1')?.textContent === 'Landing'");
  await checkSegments('route:/');
  assert.equal(await stage.getAttribute('style'), selectedTransform);
  assert.equal(await layer.locator('g path[data-edge-id="self"]').count(), 0);
});


test('proportional frames anchor observed clicks and separate failed requests from observed navigation', { timeout: 60_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      actions: [
        {id:'open',source:'route:/',target:'route:/done',label:'Next',steps:[{type:'click',selector:'#open'}]},
        {id:'wrong',source:'route:/',target:'route:/expected',label:'Different route',steps:[{type:'click',selector:'#wrong'}]},
        {id:'stay',source:'route:/',target:'route:/done',label:'Try again',steps:[{type:'click',selector:'#stay'}]},
        {id:'after-error',source:'route:/',target:'route:/done',label:'Continue after a failed request',
          steps:[{type:'click',selector:'#error-route'}]},
        {id:'after-navigation',source:'route:/',target:'route:/done',label:'Navigate before the response',
          steps:[{type:'click',selector:'#navigate-first'}],expectRequests:[{method:'POST',path:'/api/slow',status:200}]},
        {id:'pending',source:'route:/',target:'route:/done',label:'Navigate with pending request',
          steps:[{type:'click',selector:'#pending'}]},
        {id:'proof',source:'route:/',target:'route:/done',label:'Proved exchange',
          steps:[{type:'click',selector:'#proof'}],expectRequests:[{method:'POST',path:'/api/answer',status:200}]},
        {id:'missing',source:'route:/',target:'route:/expected',label:'Missing control',steps:[{type:'click',selector:'#missing'}]},
        {id:'scrolled',source:'route:/',target:'route:/done',label:'Action below the frame',steps:[{type:'click',selector:'#scrolled'}]},
        {id:'automatic',source:'route:/auto',target:'route:/done',label:'Automatic redirect',
          expectedPath:'/done',steps:[{type:'redirect'}]}
      ],
      createMocks() { return async ({path}) => {
        if (path === '/api/slow') await new Promise(resolve => setTimeout(resolve, 650));
        if (path === '/api/pending') await new Promise(resolve => setTimeout(resolve, 5000));
        return { status:path === '/api/answer' ? 200 : 501, body:{} };
      }; }
    };`,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Navigate, Routes, Route, useNavigate} from 'react-router-dom';
      function Home() {
        const go = useNavigate();
        const fail = () => fetch('/api/retry', {method:'POST'});
        return <main style={{minHeight:1650}}><h1>Canvas actions</h1>
          <button id="open" style={{position:'absolute',top:180,left:70,width:140,height:42}} onClick={() => go('/done')}>Next route</button>
          <button id="wrong" style={{position:'absolute',top:260,left:70,width:140,height:42}} onClick={() => go('/other')}>Different route</button>
          <button id="stay" style={{position:'absolute',top:330,left:70,width:140,height:42}} onClick={fail}>Try again</button>
          <button id="error-route" style={{position:'absolute',top:410,left:70,width:140,height:42}}
            onClick={async () => { await fail(); go('/done'); }}>Continue after error</button>
          <button id="navigate-first" onClick={() => { void fetch('/api/slow',{method:'POST'}); go('/done'); }}>Go then see error</button>
          <button id="pending" onClick={() => { void fetch('/api/pending',{method:'POST'}); go('/done'); }}>Wait at destination</button>
          <button id="proof" onClick={() => { void fetch('/api/retry',{method:'POST'});
            void fetch('/api/pending',{method:'POST'}); void fetch('/api/answer',{method:'POST'}); go('/done'); }}>Send the proved request</button>
          <button id="scrolled" style={{position:'absolute',top:1440,left:70,width:140,height:42}} onClick={() => go('/done')}>Action below the frame</button>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<Home/>}/>
        <Route path="/done" element={<h1>Done</h1>}/>
        <Route path="/other" element={<h1>Observed target</h1>}/>
        <Route path="/expected" element={<h1>Declared target</h1>}/>
        <Route path="/auto" element={<Navigate to="/done" replace/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const app = process.env.SCREEN_CANVAS_APP;
  const options = app ? (await preparePackagedLaunch(t, app, folder)).options : {};
  const { electron, shell } = await launchCanvas(t, options);
  await pick(electron, shell, folder);
  await waitGraph(shell, 45_000);
  const card = shell.getByRole('button', { name: '/', exact: true });
  const lines = shell.locator('#connections > g > path');
  const marks = shell.locator('#connection-origins');
  assert.equal(await lines.count(), 0);
  assert.equal(await marks.isVisible(), false);
  const frame = card.locator('img');
  await frame.waitFor();
  const layout = await card.evaluate(card => {
    const image = card.querySelector('img');
    const style = getComputedStyle(card);
    const { width, height } = image.getBoundingClientRect();
    return { width, height, cardWidth: card.offsetWidth, border: style.borderWidth, padding: style.padding,
      background: style.backgroundColor };
  });
  assert.equal(layout.width, layout.cardWidth);
  assert.ok(Math.abs(layout.height / layout.width - 844 / 390) < .005);
  assert.equal(layout.border, '0px');
  assert.equal(layout.padding, '0px');
  assert.equal(layout.background, 'rgba(0, 0, 0, 0)');
  await card.press('Enter');
  await waitGuest(electron, 'document.querySelector("#open")?.textContent === "Next route"');
  const line = id => shell.locator('#connections > g > path[data-edge-id="' + id + '"]');
  assert.equal(await line('open').getAttribute('data-target'), 'route:/done');
  assert.equal(await line('open').getAttribute('data-origin'), 'control');
  assert.equal(await line('wrong').getAttribute('data-target'), 'route:/other');
  assert.equal(await line('wrong').getAttribute('data-status'), 'unverified');
  assert.equal(await line('wrong').getAttribute('data-origin'), 'control');
  assert.equal(await line('scrolled').getAttribute('data-origin'), 'screen');
  assert.equal(await line('after-error').getAttribute('data-target'), 'route:/done');
  assert.equal(await line('stay').count(), 0);
  assert.equal(await line('missing').count(), 0);
  const detail = id => shell.locator('.edge-details li[data-edge-id="' + id + '"]');
  await detail('stay').getByText('Ошибка без перехода · POST /api/retry → 501', { exact: true }).waitFor();
  await detail('after-error').getByText('Переход наблюдался при ошибке · POST /api/retry → 501', { exact: true }).waitFor();
  await detail('wrong').getByText('Наблюдаемый путь · /other', { exact: true }).waitFor();
  await detail('wrong').getByText('Ожидаемый путь · /expected', { exact: true }).waitFor();
  await detail('after-navigation').getByText('Переход наблюдался при ошибке · POST /api/slow → 501', { exact: true }).waitFor();
  await detail('after-navigation').getByText('Заявленный обмен не подтверждён', { exact: true }).waitFor();
  await detail('pending').getByText('Локальный запрос не завершился вовремя', { exact: true }).waitFor();
  await detail('proof').getByText('Заявленный обмен подтверждён', { exact: true }).waitFor();
  await detail('proof').getByText('Фоновая ошибка · POST /api/retry → 501', { exact: true }).waitFor();
  await detail('proof').getByText('Фоновый запрос не завершился вовремя', { exact: true }).waitFor();
  assert.equal(await line('after-navigation').getAttribute('data-target'), 'route:/done');
  assert.equal(await line('pending').getAttribute('data-status'), 'unverified');
  assert.equal(await line('proof').getAttribute('data-status'), 'confirmed');
  async function checkAnchor() {
    const point = await marks.locator('[data-edge-id="open"] circle').evaluate(circle => {
      const image = document.querySelector('#cards [data-node="route:/"] img').getBoundingClientRect();
      const center = new DOMPoint(circle.cx.baseVal.value, circle.cy.baseVal.value).matrixTransform(circle.getScreenCTM());
      return { x: (center.x - image.x) / image.width, y: (center.y - image.y) / image.height,
        pointerEvents: getComputedStyle(circle).pointerEvents };
    });
    assert.ok(Math.abs(point.x - 140 / 390) < .004, JSON.stringify(point));
    assert.ok(Math.abs(point.y - 201 / 844) < .004, JSON.stringify(point));
    assert.equal(point.pointerEvents, 'none');
  }
  await checkAnchor();
  await shell.getByRole('button', { name: 'Увеличить масштаб' }).click();
  await shell.locator('#graph').press('ArrowRight');
  await checkAnchor();
  await shell.getByRole('button', { name: '/done', exact: true }).evaluate(button => button.click());
  assert.equal(await line('automatic').getAttribute('data-origin'), 'screen');
  assert.equal(await line('wrong').count(), 0);
});
