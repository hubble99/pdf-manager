import fs from 'fs';
import path from 'path';

const pagesDir = path.join(process.cwd(), 'src/pages');
const pages = [
  { file: 'MergePage.tsx', action: 'Merged PDF' },
  { file: 'ExtractPage.tsx', action: 'Extracted Pages' },
  { file: 'PdfToImagePage.tsx', action: 'PDF to Image' },
  { file: 'ImageToPdfPage.tsx', action: 'Image to PDF' },
  { file: 'InsertPage.tsx', action: 'Inserted Content' },
  { file: 'OrganizePage.tsx', action: 'Organized Pages' },
  { file: 'MetadataPage.tsx', action: 'Updated Metadata' },
];

pages.forEach(({ file, action }) => {
  const filePath = path.join(pagesDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Add import if not exists
  if (!content.includes('addHistoryEntry')) {
    content = content.replace(
      /import \{ Filename \} from '\.\.\/components\/Filename';/,
      `import { Filename } from '../components/Filename';\nimport { addHistoryEntry } from '../utils/historyStore';`
    );
  }

  // Inject addHistoryEntry
  if (!content.includes('addHistoryEntry({')) {
    // For most pages, they have: setResult({ blobUrl, filename... }) or setResult({ blobUrl, filename })
    // Then addToast('success'...
    const target = /setResult\(\{([^\}]+)\}\);/g;
    let match;
    let newContent = content;
    
    if ((match = target.exec(content)) !== null) {
      // Find the line with setResult
      const block = match[0];
      // We will look for 'fileSizeBytes' in the match to pass to history, if it doesn't exist, we fallback to 0.
      const hasSize = match[1].includes('fileSizeBytes');
      const sizeStr = hasSize ? 'fileSizeBytes' : '0';
      
      const insertStr = `${block}\n      addHistoryEntry({ filename, action: '${action}', size: ${sizeStr} });`;
      newContent = newContent.replace(block, insertStr);
    }
    
    fs.writeFileSync(filePath, newContent);
    console.log(`Updated ${file}`);
  }
});
