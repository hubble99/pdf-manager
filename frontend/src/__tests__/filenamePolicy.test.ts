import {
  appendFilenameSuffix,
  buildOutputFilename,
  sanitizeFilenameStem,
} from '../utils/filenamePolicy';

describe('filename policy', () => {
  it('preserves valid spaces and Unicode', () => {
    expect(buildOutputFilename('Hasil Editing', 'pdf')).toBe('Hasil Editing.pdf');
    expect(buildOutputFilename('Résumé Akhir', 'pdf')).toBe('Résumé Akhir.pdf');
  });

  it('replaces only invalid filename characters', () => {
    expect(buildOutputFilename('hasil:final?*', 'pdf')).toBe('hasil_final_.pdf');
  });

  it('avoids duplicate extensions and suffixes', () => {
    expect(buildOutputFilename('report.pdf', 'pdf')).toBe('report.pdf');
    expect(appendFilenameSuffix('report_unlocked.pdf', 'unlocked')).toBe('report_unlocked');
  });

  it('handles blank and Windows reserved names', () => {
    expect(sanitizeFilenameStem('   ')).toBe('output');
    expect(buildOutputFilename('CON', 'pdf')).toBe('_CON.pdf');
  });
});
