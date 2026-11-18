const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');
const { z } = require('zod');

const text = z.string().max(4000).refine(
  value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Surrogate}/u.test(value),
  'Text contains characters that Office XML cannot represent.'
);
const shortText = text.min(1).max(160);
const table = z.object({
  headers: z.array(shortText).min(1).max(12),
  rows: z.array(z.array(text).max(12)).max(200),
}).refine(value => value.rows.every(row => row.length === value.headers.length), {
  message: 'Every table row must have the same number of cells as the headers.',
});
const sheetName = shortText.max(31)
  .refine(value => !/[\\/*?:[\]\r\n\t]/.test(value) && !value.startsWith("'") && !value.endsWith("'"),
    'Sheet names cannot contain \\ / * ? : [ ], line breaks, tabs, or start/end with an apostrophe.')
  .refine(value => value.trim().length > 0 && value.toLowerCase() !== 'history',
    'Sheet names cannot be blank or use the reserved name History.');

const officeInputSchema = {
  filename: z.string().min(1).max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, 'Use a simple filename without a path or extension.')
    .optional(),
  document: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('word'),
      title: shortText,
      sections: z.array(z.object({
        heading: shortText.optional(),
        paragraphs: z.array(text).max(30).default([]),
        bullets: z.array(text).max(30).default([]),
        table: table.optional(),
      })).min(1).max(40),
    }),
    z.object({
      type: z.literal('powerpoint'),
      title: shortText,
      slides: z.array(z.object({
        title: shortText,
        bullets: z.array(shortText).max(6).default([]),
      })).min(1).max(60),
    }),
    z.object({
      type: z.literal('excel'),
      title: shortText,
      sheets: z.array(z.object({
        name: sheetName,
        rows: z.array(z.array(z.union([text, z.number().finite(), z.boolean()])).min(1).max(50))
          .min(1).max(1000),
      })).min(1).max(10).refine(
        sheets => new Set(sheets.map(sheet => sheet.name.toLowerCase())).size === sheets.length,
        'Sheet names must be unique (case-insensitive).'
      ),
    }),
  ]),
};
const inputSchema = z.object(officeInputSchema);
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function relationships(items) {
  return `<Relationships xmlns="${PACKAGE_REL}">${items.map(([id, type, target]) =>
    `<Relationship Id="${id}" Type="${OFFICE_REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

function contentTypes(items) {
  return '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    items.map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`).join('') +
    '</Types>';
}

function wordParts(document) {
  const paragraph = (value, properties = '') =>
    `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r>` +
    String(value).split(/(\r\n|\r|\n|\t)/).map(part => {
      if (part === '\t') return '<w:tab/>';
      if (/^[\r\n]+$/.test(part)) return '<w:br/>';
      return `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
    }).join('') + '</w:r></w:p>';
  const cell = value => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(value)}</w:tc>`;
  let body = paragraph(document.title, '<w:pStyle w:val="Title"/>');
  for (const section of document.sections) {
    if (section.heading) body += paragraph(section.heading, '<w:pStyle w:val="Heading1"/>');
    body += section.paragraphs.map(value => paragraph(value)).join('');
    body += section.bullets.map(value => paragraph(value,
      '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')).join('');
    if (section.table) {
      const { headers, rows } = section.table;
      body += '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
        ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
          .map(edge => `<w:${edge} w:val="single" w:sz="4" w:color="CCCCCC"/>`).join('') +
        '</w:tblBorders></w:tblPr><w:tblGrid>' +
        headers.map(() => `<w:gridCol w:w="${Math.floor(9360 / headers.length)}"/>`).join('') +
        '</w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr>' + headers.map(cell).join('') + '</w:tr>' +
        rows.map(row => `<w:tr>${row.map(cell).join('')}</w:tr>`).join('') + '</w:tbl>' + paragraph('');
    }
  }
  return {
    '[Content_Types].xml': contentTypes([
      ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
      ['word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
      ['word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'],
    ]),
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': `<w:document xmlns:w="${WORD}"><w:body>${body}` +
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" ' +
      'w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>',
    'word/_rels/document.xml.rels': relationships([
      ['rId1', 'styles', 'styles.xml'], ['rId2', 'numbering', 'numbering.xml'],
    ]),
    'word/styles.xml': `<w:styles xmlns:w="${WORD}">` +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' +
      '<w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>' +
      '<w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
      '<w:rPr><w:b/><w:color w:val="7A3E16"/><w:sz w:val="56"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr>' +
      '<w:rPr><w:b/><w:color w:val="7A3E16"/><w:sz w:val="32"/></w:rPr></w:style></w:styles>',
    'word/numbering.xml': `<w:numbering xmlns:w="${WORD}"><w:abstractNum w:abstractNumId="0">` +
      '<w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/>' +
      '<w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/>' +
      '<w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/>' +
      '</w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
  };
}

const groupShape = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function slideText(id, name, values, y, height, size, bullets = false) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="548640" y="${y}"/><a:ext cx="11094720" cy="${height}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    values.map(value => '<a:p>' +
      (bullets ? '<a:pPr marL="342900" indent="-285750"><a:spcAft><a:spcPts val="1400"/></a:spcAft>' +
        '<a:buChar char="&#8226;"/></a:pPr>' : '<a:pPr><a:buNone/></a:pPr>') +
      `<a:r><a:rPr lang="en-US" sz="${size}"${bullets ? '' : ' b="1"'}>` +
      `<a:solidFill><a:srgbClr val="${bullets ? '302820' : '7A3E16'}"/></a:solidFill>` +
      '<a:latin typeface="Calibri"/></a:rPr>' +
      `<a:t>${escapeXml(value)}</a:t></a:r></a:p>`).join('') + '</p:txBody></p:sp>';
}

function presentationTheme() {
  const colors = {
    dk1: '302820', lt1: 'FFFFFF', dk2: '7A3E16', lt2: 'FFF8F0',
    accent1: 'C65D24', accent2: 'DCA73A', accent3: '65834B',
    accent4: '6D91A3', accent5: '9872A3', accent6: 'B85762',
    hlink: '0563C1', folHlink: '954F72',
  };
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const fonts = '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>';
  return `<a:theme xmlns:a="${DRAWING}" name="Maple"><a:themeElements><a:clrScheme name="Maple">` +
    Object.entries(colors).map(([name, color]) => `<a:${name}><a:srgbClr val="${color}"/></a:${name}>`).join('') +
    '</a:clrScheme><a:fontScheme name="Maple"><a:majorFont>' + fonts + '</a:majorFont><a:minorFont>' +
    fonts + '</a:minorFont></a:fontScheme><a:fmtScheme name="Maple"><a:fillStyleLst>' + fill.repeat(3) +
    '</a:fillStyleLst><a:lnStyleLst>' +
    [9525, 25400, 38100].map(width => `<a:ln w="${width}">${fill}<a:prstDash val="solid"/></a:ln>`).join('') +
    '</a:lnStyleLst><a:effectStyleLst>' + '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) +
    '</a:effectStyleLst><a:bgFillStyleLst>' + fill.repeat(3) +
    '</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>';
}

function powerpointParts(document) {
  const presentationType = 'application/vnd.openxmlformats-officedocument.presentationml.';
  const parts = {
    '[Content_Types].xml': contentTypes([
      ['ppt/presentation.xml', `${presentationType}presentation.main+xml`],
      ['ppt/slideMasters/slideMaster1.xml', `${presentationType}slideMaster+xml`],
      ['ppt/slideLayouts/slideLayout1.xml', `${presentationType}slideLayout+xml`],
      ['ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
      ...document.slides.map((_, i) => [`ppt/slides/slide${i + 1}.xml`, `${presentationType}slide+xml`]),
    ]),
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `<p:presentation xmlns:p="${PRESENTATION}" xmlns:r="${OFFICE_REL}">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' +
      document.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('') +
      '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>' +
      '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relationships([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ...document.slides.map((_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`]),
    ]),
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster xmlns:p="${PRESENTATION}" xmlns:a="${DRAWING}" xmlns:r="${OFFICE_REL}">` +
      `<p:cSld><p:spTree>${groupShape}</p:spTree></p:cSld>` +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
      'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
      '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': relationships([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml'],
    ]),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout xmlns:p="${PRESENTATION}" xmlns:a="${DRAWING}" type="blank" preserve="1">` +
      `<p:cSld name="Blank"><p:spTree>${groupShape}</p:spTree></p:cSld>` +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': relationships([
      ['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'],
    ]),
    'ppt/theme/theme1.xml': presentationTheme(),
  };
  document.slides.forEach((slide, i) => {
    parts[`ppt/slides/slide${i + 1}.xml`] =
      `<p:sld xmlns:p="${PRESENTATION}" xmlns:a="${DRAWING}"><p:cSld>` +
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFF8F0"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
      `<p:spTree>${groupShape}${slideText(2, 'Title', [slide.title], 365760, 1097280, 3200)}` +
      `${slideText(3, 'Content', slide.bullets.length ? slide.bullets : [''], 1645920, 4754880, 2200, true)}` +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
    parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = relationships([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
    ]);
  });
  return parts;
}

function columnName(index) {
  let name = '';
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

function excelParts(document) {
  const spreadsheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
  const parts = {
    '[Content_Types].xml': contentTypes([
      ['xl/workbook.xml', `${spreadsheetType}sheet.main+xml`],
      ...document.sheets.map((_, i) => [`xl/worksheets/sheet${i + 1}.xml`, `${spreadsheetType}worksheet+xml`]),
    ]),
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<workbook xmlns="${SHEET}" xmlns:r="${OFFICE_REL}"><sheets>` +
      document.sheets.map((sheet, i) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relationships(
      document.sheets.map((_, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`])
    ),
  };
  document.sheets.forEach((sheet, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet xmlns="${SHEET}"><sheetData>` +
      sheet.rows.map((row, r) => `<row r="${r + 1}">` + row.map((value, c) => {
        const reference = `${columnName(c)}${r + 1}`;
        if (typeof value === 'string') {
          // Inline strings keep user text such as "=SUM(A1:A2)" from becoming executable formulas.
          return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        }
        return `<c r="${reference}" t="${typeof value === 'boolean' ? 'b' : 'n'}"><v>${Number(value)}</v></c>`;
      }).join('') + '</row>').join('') + '</sheetData></worksheet>';
  });
  return parts;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Office Open XML files are ZIP packages. All entry names here are fixed by the builders above.
function zipParts(parts) {
  const entries = [];
  const directory = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(parts)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(XML + xml);
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034B50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); // DOS date: January 1, 1980.
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    entries.push(header, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, centralDirectory, end]);
}

async function createOfficeFile(input, outputDirectory) {
  const { filename, document } = inputSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(document)) > 1024 * 1024) {
    throw new Error('Document content exceeds the 1 MB limit. Split it into smaller files.');
  }
  const builders = {
    word: ['docx', wordParts], powerpoint: ['pptx', powerpointParts], excel: ['xlsx', excelParts],
  };
  const [extension, build] = builders[document.type];
  const parts = build(document);
  parts['docProps/core.xml'] =
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${escapeXml(document.title)}</dc:title><dc:creator>Maple</dc:creator></cp:coreProperties>`;
  parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace('</Types>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  parts['_rels/.rels'] = parts['_rels/.rels'].replace('</Relationships>',
    '<Relationship Id="core" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" ' +
    'Target="docProps/core.xml"/></Relationships>');
  const buffer = zipParts(parts);
  await fs.mkdir(outputDirectory, { recursive: true });
  const target = path.join(outputDirectory, `${filename || 'Maple'}-${randomUUID()}.${extension}`);
  await fs.writeFile(target, buffer, { flag: 'wx' });
  return target;
}

function registerOfficeTools(server, outputDirectory) {
  server.registerTool('create_office_file', {
    title: 'Create a Word document, PowerPoint presentation, or Excel workbook',
    description:
      'Creates a real .docx, .pptx, or .xlsx locally in the user\'s Documents\\Maple folder, without Office or Cowork. ' +
      'Provide document.type: word (title and sections with heading, paragraphs, bullets, optional table with headers/rows), ' +
      'powerpoint (title and slides with title and up to 6 concise bullets each), or excel (title and named sheets with rows ' +
      'of text, numbers, or booleans). Spreadsheet text is never evaluated as formulas. Content limit: 1 MB. ' +
      'No macros, scripts, external data fetching, templates, images, or editing existing files. ' +
      'Use filename for an optional simple base name without extension or path. Files get unique names and never overwrite ' +
      'existing files. Returns the saved absolute path; use open_path to open it if requested. ' +
      'Generated resources are private local files, not project code; never commit them to GitHub.',
    inputSchema: officeInputSchema,
  }, async input => {
    try {
      const target = await createOfficeFile(input, outputDirectory);
      return { content: [{ type: 'text', text: `Created Office file: ${target}` }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `create_office_file failed: ${error.message}` }],
        isError: true,
      };
    }
  });
}

module.exports = { createOfficeFile, registerOfficeTools };
