// Converts report.docx to PDF and writes out/report.pdf.
// Run from a folder holding report.docx: node quick-start.mjs
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi(); // reads PDFCONVERSIONAPI_KEY
const result = await client.convertFile("report.docx", "pdf");
const paths = await result.saveAll("out");
console.log(paths);
