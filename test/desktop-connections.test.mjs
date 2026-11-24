import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick, waitGuest } from './helpers/electron.mjs';
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
  assert.equal(await stage.locator('canvas, .edge-label, #edge-labels').count(), 0);
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
  const edges = await shell.evaluate(async () => (await screenCanvas.state()).graph.edges);
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
  assert.equal(await stage.locator('canvas, .edge-label, #edge-labels').count(), 0);
});
