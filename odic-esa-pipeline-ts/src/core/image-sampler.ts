/**
 * Intelligent page sampling for vision AI analysis.
 * Selects the most informative pages from large PDFs
 * without sending everything to Claude Vision (cost control).
 */

/**
 * Select which pages to analyze from a document based on type and budget.
 *
 * @param totalPages Total pages in the PDF
 * @param documentType Classification type (aerial_photograph, site_photograph, etc.)
 * @param maxBudget Maximum number of images to send (default 6)
 * @returns Array of 1-based page numbers to analyze
 */
export function selectPagesToAnalyze(
  totalPages: number,
  documentType: string,
  maxBudget: number = 6
): number[] {
  if (totalPages <= 0) return [];
  if (totalPages <= maxBudget) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  if (documentType === 'aerial_photograph') {
    // Aerials are chronological: oldest first, newest last.
    // Sample first (oldest), last (newest), and evenly spaced between.
    const pages = new Set<number>([1, totalPages]);
    const remaining = maxBudget - 2;
    const step = Math.floor(totalPages / (remaining + 1));
    for (let i = 1; i <= remaining; i++) {
      pages.add(Math.min(i * step, totalPages));
    }
    return [...pages].sort((a, b) => a - b);
  }

  if (documentType === 'site_photograph') {
    // Site photos: first few pages usually have overview shots,
    // plus samples from middle and end for variety.
    const pages = new Set<number>([1]);
    if (totalPages >= 2) pages.add(2);
    if (totalPages >= 3) pages.add(3);
    if (totalPages > 6) pages.add(Math.floor(totalPages / 2));
    if (totalPages > 4) pages.add(totalPages);
    return [...pages].sort((a, b) => a - b).slice(0, maxBudget);
  }

  if (documentType === 'sanborn_map' || documentType === 'topographic_map') {
    // Maps: first page is usually the index/overview, last is most recent.
    const pages = new Set<number>([1]);
    if (totalPages > 1) pages.add(totalPages);
    if (totalPages > 4) pages.add(Math.floor(totalPages / 2));
    return [...pages].sort((a, b) => a - b).slice(0, maxBudget);
  }

  // Default: even spread across the document
  const step = Math.max(1, Math.floor(totalPages / maxBudget));
  const pages: number[] = [];
  for (let i = 0; i < maxBudget && i * step + 1 <= totalPages; i++) {
    pages.push(i * step + 1);
  }
  return pages;
}
