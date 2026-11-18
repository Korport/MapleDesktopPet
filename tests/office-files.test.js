const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { createOfficeFile } = require('../src/mcp/office-files');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-office-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// Read the central directory independently, including local-header offsets and CRCs.
async function readPackage(filename) {
  const data = await fs.readFile(filename);
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054B50);
  const count = data.readUInt16LE(end + 10);
  let position = data.readUInt32LE(end + 16);
  assert.equal(position + data.readUInt32LE(end + 12), end);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(position), 0x02014B50);
    const nameLength = data.readUInt16LE(position + 28);
    const name = data.subarray(position + 46, position + 46 + nameLength).toString();
    const offset = data.readUInt32LE(position + 42);
    assert.equal(data.readUInt32LE(offset), 0x04034B50);
    assert.equal(data.readUInt16LE(offset + 8), 8);
    assert.equal(data.readUInt16LE(offset + 26), nameLength);
    assert.equal(data.subarray(offset + 30, offset + 30 + nameLength).toString(), name);
    const start = offset + 30 + nameLength + data.readUInt16LE(offset + 28);
    const bytes = inflateRawSync(data.subarray(start, start + data.readUInt32LE(position + 20)));
    assert.equal(bytes.length, data.readUInt32LE(position + 24));
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
    assert.equal((crc ^ 0xFFFFFFFF) >>> 0, data.readUInt32LE(position + 16));
    assert.equal(data.readUInt32LE(offset + 14), data.readUInt32LE(position + 16));
    files[name] = bytes.toString('utf8');
    position += 46 + nameLength + data.readUInt16LE(position + 30) + data.readUInt16LE(position + 32);
  }
  assert.equal(position, end);
  for (const [name, xml] of Object.entries(files)) {
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"/);
    if (!name.endsWith('.rels')) continue;
    const base = name === '_rels/.rels' ? '' : path.posix.dirname(path.posix.dirname(name));
    for (const match of xml.matchAll(/Target="([^"]+)"/g)) {
      const target = path.posix.normalize(path.posix.join(base, match[1]));
      assert.ok(files[target], `${name} points to missing part ${target}`);
    }
  }
  for (const match of files['[Content_Types].xml'].matchAll(/PartName="\/([^"]+)"/g)) {
    assert.ok(files[match[1]], `Missing content-type part: ${match[1]}`);
  }
  return files;
}

test('creates a Word package with escaped Unicode text, headings, lists, and tables', async t => {
  const output = await temporaryDirectory(t);
  const filename = await createOfficeFile({
    filename: 'Project brief',
    document: {
      type: 'word', title: 'R&D <brief>',
      sections: [{
        heading: 'Overview',
        paragraphs: ['A & B <w:evil/> "quoted" \u{1F98A}\nNext\tcolumn'],
        bullets: ['One', 'Two'],
        table: { headers: ['Owner', 'Status'], rows: [['Maple', 'Ready']] },
      }],
    },
  }, output);
  assert.equal(path.dirname(filename), output);
  assert.match(path.basename(filename), /^Project brief-.+\.docx$/);
  const files = await readPackage(filename);
  assert.match(files['word/document.xml'], /w:pStyle w:val="Heading1"/);
  assert.match(files['word/document.xml'], /A &amp; B &lt;w:evil\/&gt; &quot;quoted&quot; \u{1F98A}/u);
  assert.match(files['word/document.xml'], /<w:br\/>/);
  assert.match(files['word/document.xml'], /<w:tab\/>/);
  assert.match(files['word/document.xml'], /<w:numId w:val="1"/);
  assert.match(files['word/numbering.xml'], /w:numFmt w:val="bullet"/);
  assert.match(files['word/document.xml'], /<w:tblHeader\/>/);
  assert.match(files['word/document.xml'], /<w:t xml:space="preserve">Ready<\/w:t>/);
  assert.match(files['docProps/core.xml'], /R&amp;D &lt;brief&gt;/);
});

test('creates a widescreen PowerPoint with editable slides and complete master/layout/theme relationships', async t => {
  const output = await temporaryDirectory(t);
  const filename = await createOfficeFile({
    document: {
      type: 'powerpoint', title: 'Launch plan',
      slides: [
        { title: 'Launch <overview>', bullets: ['Goals & scope', 'Next steps'] },
        { title: 'Questions' },
      ],
    },
  }, output);
  assert.equal(path.extname(filename), '.pptx');
  const files = await readPackage(filename);
  assert.match(files['ppt/presentation.xml'], /cx="12192000" cy="6858000"/);
  assert.equal((files['ppt/presentation.xml'].match(/<p:sldId /g) || []).length, 2);
  assert.match(files['ppt/slides/slide1.xml'], /Launch &lt;overview&gt;/);
  assert.match(files['ppt/slides/slide1.xml'], /Goals &amp; scope/);
  assert.match(files['ppt/slides/slide2.xml'], /Questions/);
  assert.match(files['ppt/slideMasters/slideMaster1.xml'], /p:sldLayoutId/);
  assert.match(files['ppt/theme/theme1.xml'], /a:themeElements/);
});

test('creates Excel sheets with typed cells, wide column addresses, and inert formula-like strings', async t => {
  const output = await temporaryDirectory(t);
  const row = Array.from({ length: 28 }, (_, i) => `Column ${i + 1}`);
  const filename = await createOfficeFile({
    document: {
      type: 'excel', title: 'Resource tracker',
      sheets: [
        { name: 'R&D', rows: [row, ['=HYPERLINK("https://example.com")', -12.5, true, false, '<tag>']] },
        { name: 'Summary', rows: [['Ready']] },
      ],
    },
  }, output);
  assert.equal(path.extname(filename), '.xlsx');
  const files = await readPackage(filename);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(files['xl/workbook.xml'], /name="R&amp;D"/);
  assert.match(sheet, /r="AB1" t="inlineStr"/);
  assert.match(sheet, /r="A2" t="inlineStr"/);
  assert.match(sheet, /=HYPERLINK\(&quot;https:\/\/example.com&quot;\)/);
  assert.doesNotMatch(sheet, /<f[ >]/);
  assert.match(sheet, /r="B2" t="n"><v>-12.5<\/v>/);
  assert.match(sheet, /r="C2" t="b"><v>1<\/v>/);
  assert.match(sheet, /r="D2" t="b"><v>0<\/v>/);
  assert.match(files['xl/worksheets/sheet2.xml'], /Ready/);
});

test('rejects unsafe filenames, invalid XML, invalid tables, and invalid or duplicate sheet names before writing', async t => {
  const output = await temporaryDirectory(t);
  const word = { type: 'word', title: 'Brief', sections: [{}] };
  for (const filename of ['..\\escape', '../escape', 'C:\\escape', 'file.docx']) {
    await assert.rejects(createOfficeFile({ filename, document: word }, output));
  }
  for (const title of ['Bad\u0000text', 'Bad\uD800text', 'Bad\uFFFFtext']) {
    await assert.rejects(createOfficeFile({ document: { ...word, title } }, output));
  }
  await assert.rejects(createOfficeFile({
    document: { ...word, sections: [{ table: { headers: ['A', 'B'], rows: [['Only one']] } }] },
  }, output));
  for (const names of [
    ['Data', 'data'], ['bad/name'], ['bad[name'], ["'bad"], ['History'], ['   '], ['a\tb', 'a b'], ['a\nb'],
  ]) {
    await assert.rejects(createOfficeFile({
      document: { type: 'excel', title: 'Book', sheets: names.map(name => ({ name, rows: [['Value']] })) },
    }, output));
  }
  assert.deepEqual(await fs.readdir(output), []);
});

test('enforces total content limits without creating an output directory', async t => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, 'not-created');
  await assert.rejects(createOfficeFile({
    document: {
      type: 'word', title: 'Too large',
      sections: Array.from({ length: 10 }, () => ({ paragraphs: Array(30).fill('x'.repeat(4000)) })),
    },
  }, output), /1 MB limit/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('creates missing directories and never overwrites files with the same requested name', async t => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, 'nested', 'Maple');
  const input = { filename: 'Brief', document: { type: 'word', title: 'Brief', sections: [{}] } };
  const filenames = await Promise.all([createOfficeFile(input, output), createOfficeFile(input, output)]);
  assert.notEqual(filenames[0], filenames[1]);
  assert.equal((await fs.readdir(output)).length, 2);
  await Promise.all(filenames.map(readPackage));
});

test('the real MCP server advertises and executes Office creation, reporting write errors explicitly', async t => {
  const output = await temporaryDirectory(t);
  const client = new Client({ name: 'maple-office-tests', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'src', 'mcp', 'actions-server.js')],
    env: { ...process.env, MAPLE_DOCUMENTS_DIR: path.join(output, 'Maple') },
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'create_office_file'));
  const result = await client.callTool({
    name: 'create_office_file',
    arguments: { document: { type: 'word', title: 'Through MCP', sections: [{ paragraphs: ['It works.'] }] } },
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const filename = result.content[0].text.replace('Created Office file: ', '');
  assert.equal(path.dirname(filename), path.join(output, 'Maple'));
  assert.match((await readPackage(filename))['word/document.xml'], /It works\./);
  const invalid = await client.callTool({
    name: 'create_office_file',
    arguments: { filename: '..\\outside', document: { type: 'word', title: 'Bad', sections: [{}] } },
  });
  assert.equal(invalid.isError, true);

  await fs.unlink(filename);
  await fs.rmdir(path.join(output, 'Maple'));
  await fs.writeFile(path.join(output, 'Maple'), 'A file is not a directory');
  const failure = await client.callTool({
    name: 'create_office_file',
    arguments: { document: { type: 'excel', title: 'Blocked', sheets: [{ name: 'Data', rows: [[1]] }] } },
  });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /^create_office_file failed:/);
});
