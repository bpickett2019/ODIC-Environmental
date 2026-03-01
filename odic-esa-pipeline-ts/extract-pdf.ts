import * as fs from 'fs';
import pdfParse from 'pdf-parse';

const pdfPath = '/sessions/wonderful-youthful-darwin/mnt/uploads/6384642-ESAI-Report.pdf';
const outputPath = '/sessions/wonderful-youthful-darwin/mnt/outputs/pdf2-extraction.txt';

interface PDFData {
  numpages: number;
  pages?: Array<{ text: string }>;
  text: string;
  version: string;
}

async function extractPdfText() {
  try {
    console.log(`Reading PDF from: ${pdfPath}`);
    const pdfBuffer = fs.readFileSync(pdfPath);
    
    console.log('Parsing PDF...');
    const pdfData = await pdfParse(pdfBuffer) as PDFData;
    
    const totalPages = pdfData.numpages;
    console.log(`Total pages in PDF: ${totalPages}`);
    
    let output = `PDF Text Extraction Report\n`;
    output += `================================\n`;
    output += `File: ${pdfPath}\n`;
    output += `Total Pages: ${totalPages}\n`;
    output += `Extraction: First 300 characters from each page (1-60, plus samples)\n`;
    output += `================================\n\n`;
    
    // Split text by page breaks - try multiple approaches
    let pageTexts: string[] = [];
    
    // Approach 1: Try to use pages array if available
    if (pdfData.pages && Array.isArray(pdfData.pages) && pdfData.pages.length > 0) {
      console.log(`Found ${pdfData.pages.length} pages in pages array`);
      pageTexts = pdfData.pages.map((p: any) => p.text || '');
    } 
    // Approach 2: Split by form feed or common page separator
    else if (pdfData.text) {
      console.log('Attempting to split text by page separators...');
      // Try form feed character
      let splits = pdfData.text.split('\f');
      if (splits.length > 1) {
        pageTexts = splits;
        console.log(`Split by form feed: ${splits.length} segments`);
      } else {
        // Try by double newline sequences
        splits = pdfData.text.split(/\n\n+/);
        if (splits.length >= totalPages / 2) {
          pageTexts = splits;
          console.log(`Split by double newlines: ${splits.length} segments`);
        } else {
          // Just treat the whole text as one
          pageTexts = [pdfData.text];
          console.log('Could not split text, treating as single document');
        }
      }
    }
    
    console.log(`Total text segments found: ${pageTexts.length}`);
    
    // Pages 1-60
    console.log('Extracting pages 1-60...');
    output += `PAGES 1-60:\n`;
    output += `-----------\n`;
    
    for (let i = 1; i <= Math.min(60, totalPages); i++) {
      const pageIdx = i - 1;
      const pageText = pageIdx < pageTexts.length ? pageTexts[pageIdx] : '';
      const excerpt = pageText.substring(0, 300).replace(/\n/g, ' ').trim();
      const displayText = excerpt.length > 0 ? excerpt : '[Empty page]';
      output += `[Page ${i}] ${displayText}\n\n`;
    }
    
    // Sample pages
    const samplePages = [100, 200, 500, 1000, 1500, 2000];
    const lastPages = [];
    for (let i = Math.max(2340, totalPages - 4); i <= totalPages; i++) {
      if (i >= 1) lastPages.push(i);
    }
    
    const allSamplePages = [...new Set([...samplePages, ...lastPages])].filter(p => p <= totalPages).sort((a, b) => a - b);
    
    if (allSamplePages.length > 0) {
      console.log(`Extracting sample pages: ${allSamplePages.join(', ')}`);
      output += `\nSAMPLE PAGES:\n`;
      output += `-----------\n`;
      
      for (const pageNum of allSamplePages) {
        const pageIdx = pageNum - 1;
        const pageText = pageIdx < pageTexts.length ? pageTexts[pageIdx] : '';
        const excerpt = pageText.substring(0, 300).replace(/\n/g, ' ').trim();
        const displayText = excerpt.length > 0 ? excerpt : '[Empty page]';
        output += `[Page ${pageNum}] ${displayText}\n\n`;
      }
    }
    
    console.log(`Writing output to: ${outputPath}`);
    fs.writeFileSync(outputPath, output);
    
    console.log('Extraction complete!');
    console.log(`Output written to: ${outputPath}`);
    console.log(`Total output size: ${output.length} characters`);
    
  } catch (error) {
    console.error('Error extracting PDF:', error);
    process.exit(1);
  }
}

extractPdfText();
