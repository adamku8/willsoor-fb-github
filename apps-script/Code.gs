/**
 * Willsoor FB — Approval web app (Apps Script)
 *
 * Replaces the Cowork artifact.
 *
 * Endpoints (called from Index.html via google.script.run):
 *   getDrafts()            — read all rows from Willsoor FB log
 *   approve(rowNum, mode, dueAt)  — publish to Buffer + update Sheet status
 *   reject(rowNum)         — mark rejected_via_appscript in Sheet
 *   editCopy(rowNum, copy) — overwrite I{row} with new copy
 *   testBuffer()           — sanity check Buffer access token
 *
 * Setup (one-time):
 *   File → Project Properties → Script Properties → add:
 *     SHEET_ID         = 1hAik549awmVTEk7_xYX0COx-dLQrtrSp8pm6tBhy00Y
 *     BUFFER_TOKEN     = <your Buffer Personal Access Token from publish.buffer.com>
 *     BUFFER_PROFILE_ID = 69f4e9135c4c051afafe1b4c   (Willsoor.cz FB channel)
 *
 * Buffer auth: Personal Access Token (OIDC), used as `Authorization: Bearer <token>`.
 * Endpoint:    https://api.buffer.com/graphql (v2 GraphQL — old api.bufferapp.com/1 is deprecated for OIDC tokens).
 */

// ── Constants & helpers ─────────────────────────────────────────────────────

const COLS = [
  'date','source_priority','source_detail','product_url','product_id',
  'category','angle','template','copy','hashtags','audit_passed','status',
  'buffer_post_id','scheduled_at','approval_method','approved_at','rejected_at',
  'likes','comments','shares','reach','clicks','score','evaluated_at','notes',
  'lifestyle_photo_url','post_type'
];

function _props() {
  return PropertiesService.getScriptProperties();
}

function _sheet() {
  const id = _props().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID not set in Script Properties.');
  return SpreadsheetApp.openById(id).getSheetByName('Sheet1');
}

function _rowToObj(row, rowNum) {
  const o = { _row: rowNum };
  for (let i = 0; i < COLS.length; i++) {
    let v = row[i];
    if (v == null) {
      o[COLS[i]] = '';
    } else if (v instanceof Date) {
      // Sheets sometimes returns Date objects for date-formatted cells.
      // Column 'date' (idx 0) is YYYY-MM-DD only; 'scheduled_at' (idx 13) and 'approved_at' (idx 15)
      // and 'rejected_at' (idx 16) and 'evaluated_at' (idx 23) include time.
      const colName = COLS[i];
      if (colName === 'date') {
        o[COLS[i]] = Utilities.formatDate(v, 'Europe/Prague', 'yyyy-MM-dd');
      } else {
        // ISO 8601 with timezone offset for time-containing columns
        o[COLS[i]] = Utilities.formatDate(v, 'Europe/Prague', "yyyy-MM-dd'T'HH:mm:ssXXX");
      }
    } else {
      o[COLS[i]] = String(v);
    }
  }
  return o;
}

function _statusKind(s) {
  s = String(s || '').toLowerCase();
  if (s.startsWith('approved') || s.startsWith('published') || s.startsWith('scheduled')) return 'approved';
  if (s.startsWith('rejected') || s.startsWith('cancelled') || s.startsWith('canceled')) return 'rejected';
  return 'pending';
}

// ── Web app entry ──────────────────────────────────────────────────────────

function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Willsoor FB — schvalování')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ── Reads ──────────────────────────────────────────────────────────────────

function getDrafts() {
  const sheet = _sheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { rows: [] };
  const values = sheet.getRange(2, 1, lastRow - 1, COLS.length).getValues();
  const rows = values
    .map((row, idx) => _rowToObj(row, idx + 2))
    .filter(r => r.date || r.copy || r.product_id);
  return {
    rows: rows,
    summary: {
      pending: rows.filter(r => _statusKind(r.status) === 'pending').length,
      approved: rows.filter(r => _statusKind(r.status) === 'approved').length,
      rejected: rows.filter(r => _statusKind(r.status) === 'rejected').length
    }
  };
}

// ── Writes ─────────────────────────────────────────────────────────────────

function _setCells(rowNum, colToValue) {
  const sheet = _sheet();
  Object.keys(colToValue).forEach(letter => {
    const colIdx = letter.charCodeAt(0) - 64; // 'A' → 1
    sheet.getRange(rowNum, colIdx).setValue(colToValue[letter]);
  });
}

function editCopy(rowNum, newCopy) {
  if (!newCopy || !String(newCopy).trim()) {
    return { ok: false, error: 'Caption nemůže být prázdný.' };
  }
  // Normalize to one-line for the I column (\n\n→ ' / ' is the convention)
  const oneLine = String(newCopy).replace(/\n\n+/g, ' / ').replace(/\n+/g, ' / ').trim();
  _setCells(rowNum, { I: oneLine });
  return { ok: true };
}

function reject(rowNum) {
  _setCells(rowNum, {
    L: 'rejected_via_appscript',
    O: 'appscript',
    Q: new Date().toISOString()
  });
  return { ok: true };
}

function approve(rowNum, mode, dueAtIso) {
  const sheet = _sheet();
  const row = sheet.getRange(rowNum, 1, 1, COLS.length).getValues()[0];
  const r = _rowToObj(row, rowNum);

  if (!r.copy) return { ok: false, error: 'Řádek nemá caption.' };

  const result = _publishToBuffer(r, mode, dueAtIso);
  if (!result.ok) return result;

  _setCells(rowNum, {
    L: 'approved_via_appscript',
    M: result.bufferPostId || '',
    N: dueAtIso || '',
    O: 'appscript',
    P: new Date().toISOString()
  });

  return { ok: true, bufferPostId: result.bufferPostId };
}

// ── Buffer API (GraphQL v2 — api.buffer.com/graphql) ───────────────────────

const BUFFER_GRAPHQL = 'https://api.buffer.com/graphql';

function _bufferGraphQL(query, variables) {
  const token = _props().getProperty('BUFFER_TOKEN');
  if (!token) return { ok: false, error: 'BUFFER_TOKEN not set in Script Properties.' };

  const options = {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ query: query, variables: variables || {} }),
    muteHttpExceptions: true
  };

  let resp;
  try {
    resp = UrlFetchApp.fetch(BUFFER_GRAPHQL, options);
  } catch (e) {
    return { ok: false, error: 'Buffer fetch failed: ' + e.message };
  }
  const code = resp.getResponseCode();
  let body = {};
  try { body = JSON.parse(resp.getContentText()); } catch (e) { body = { raw: resp.getContentText().slice(0, 500) }; }

  if (code !== 200) return { ok: false, error: 'Buffer HTTP ' + code, body: body };
  if (body.errors) return { ok: false, error: 'GraphQL: ' + JSON.stringify(body.errors).slice(0, 400), body: body };
  return { ok: true, data: body.data };
}

function _publishToBuffer(r, mode, dueAtIso) {
  const channelId = _props().getProperty('BUFFER_PROFILE_ID');
  if (!channelId) return { ok: false, error: 'BUFFER_PROFILE_ID not set in Script Properties.' };

  // Convert "Hook / paragraph 2 / paragraph 3 / hashtags" back to multi-paragraph
  const text = String(r.copy || '').replace(/ \/ /g, '\n\n');

  // Map artifact mode → GraphQL ShareMode enum
  const shareMode = (mode === 'shareNow' || mode === 'now') ? 'shareNow' : 'customScheduled';

  const input = {
    channelId: channelId,
    schedulingType: 'automatic',
    mode: shareMode,
    text: text,
    metadata: {
      facebook: { type: 'post' }
    }
  };

  if (shareMode === 'customScheduled' && dueAtIso) {
    input.dueAt = dueAtIso;
  }

  if (r.lifestyle_photo_url) {
    input.assets = {
      images: [{
        url: r.lifestyle_photo_url,
        metadata: {
          altText: 'Willsoor lifestyle foto, ' + (r.category || 'produkt') + ', ' + (r.date || '')
        }
      }]
    };
  } else if (r.product_url) {
    // No image — fall back to link card via Facebook metadata
    input.metadata.facebook.linkAttachment = { url: r.product_url };
  }

  const mutation = [
    'mutation CreatePost($input: CreatePostInput!) {',
    '  createPost(input: $input) {',
    '    __typename',
    '    ... on PostActionSuccess { post { id status } }',
    '    ... on NotFoundError { message }',
    '    ... on UnauthorizedError { message }',
    '    ... on UnexpectedError { message }',
    '    ... on RestProxyError { message code link }',
    '    ... on LimitReachedError { message }',
    '    ... on InvalidInputError { message }',
    '  }',
    '}'
  ].join('\n');

  const res = _bufferGraphQL(mutation, { input: input });
  if (!res.ok) return res;

  const payload = (res.data && res.data.createPost) || {};
  if (payload.__typename === 'PostActionSuccess') {
    return { ok: true, bufferPostId: (payload.post && payload.post.id) || '', status: payload.post && payload.post.status };
  }
  // any error variant
  return { ok: false, error: 'Buffer ' + payload.__typename + ': ' + (payload.message || 'unknown'), payload: payload };
}

// ── Diagnostic ─────────────────────────────────────────────────────────────

function testBuffer() {
  const query = '{ account { id email organizations { id name channels { id service serviceId name } } } }';
  const res = _bufferGraphQL(query);
  if (!res.ok) return res;
  const acct = res.data.account;
  const channels = (acct.organizations || []).flatMap(o => (o.channels || []).map(c => ({
    org: o.name,
    id: c.id,
    service: c.service,
    name: c.name
  })));
  return {
    ok: true,
    email: acct.email,
    channels: channels,
    note: 'BUFFER_PROFILE_ID v Script Properties má být id z této listy odpovídající Willsoor.cz / facebook.'
  };
}
