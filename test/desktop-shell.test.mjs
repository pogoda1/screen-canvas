import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick, guestEval, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('the fixed shell stays usable after an attempted navigation and on a new launch', { timeout: 35_000 }, async t => {
  const folder = await makeHost(t);
  for (const attempt of [true, false]) {
    const { electron, shell } = await launchCanvas(t);
    const fixed = 'app://canvas/index.html';
    const committed = [];
    shell.on('framenavigated', frame => { if (frame === shell.mainFrame()) committed.push(frame.url()); });
    assert.equal(shell.url(), fixed);
    await pick(electron, shell, folder);
    const card = shell.getByRole('button', { name: '/', exact: true });
    await card.click();
    await waitGuest(electron, "document.querySelector('h1')?.textContent === 'Home screen'");
    if (attempt) {
      await shell.evaluate(() => { location.href = 'about:blank'; }).catch(error => {
        if (!error.message.includes('Execution context was destroyed')) throw error;
      });
      await shell.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
      assert.equal(shell.url(), fixed);
      assert.deepEqual(committed, []);
      assert.equal(await card.getAttribute('aria-pressed'), 'true');
      await guestEval(electron, "document.querySelector('a').click()");
      await waitGuest(electron, "document.querySelector('h1')?.textContent === 'Next screen'");
    }
    await shell.getByRole('button', { name: 'Закрыть проект' }).click();
    await shell.getByText('Выберите папку локального React-проекта').waitFor();
    await electron.close();
  }
});
