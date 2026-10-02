// Network: one authenticated, time-limited request per window.
const FETCH_TIMEOUT_MS = 15000;

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Resolves with the window's data or rejects with a message fit for the user.
// Aborting `controller` cancels the request (the caller moved on).
async function fetchWindow(api, initData, controller) {
  let isTimedOut = false;
  const timer = setTimeout(() => {
    isTimedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/${api}`, {
      headers: { Authorization: "tma " + initData },
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    if (body === null) throw new Error("the server sent an unreadable answer");
    return body;
  } catch (error) {
    if (isTimedOut) throw new Error(`no answer within ${FETCH_TIMEOUT_MS / 1000} s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Ask the server to do something (POST, no body: the action is fixed by the
// path). Resolves with the answer or rejects with a message fit for the user.
async function postAction(path, initData) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/${path}`, {
      method: "POST",
      headers: { Authorization: "tma " + initData },
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    return body || {};
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`no answer within ${FETCH_TIMEOUT_MS / 1000} s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
