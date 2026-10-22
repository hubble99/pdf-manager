import { ArrowRight, CheckCircle, Minimize2 } from 'lucide-react';
import { formatBytes } from '../../utils/compressPdf';
import { t } from '../../i18n';

interface SizeCompareCardProps {
  sizeBefore: number;
  /** Set once compression finished; until then the "After" box shows a dash. */
  result?: { sizeAfter: number; reductionPct: number } | null;
}

/** Before / after file size card shared by Compress PDF and Compress Photos. */
export function SizeCompareCard({ sizeBefore, result }: SizeCompareCardProps) {
  return (
    <div className="card card--flush">
      <div className="card-head">
        <span className="card-head-title">
          <Minimize2 size={16} className="card-head-icon" aria-hidden="true" />
          {t('Size')}
        </span>
        {result && (
          <span className="card-head-actions status-ok">
            <CheckCircle size={14} aria-hidden="true" /> {t('Compression complete')}
          </span>
        )}
      </div>
      <div className="card-body">
        <div className="size-compare">
          <div className="size-box">
            <small>{t('Before')}</small>
            <b>{formatBytes(sizeBefore)}</b>
            <div className="size-bar"><i style={{ width: '100%' }} /></div>
          </div>
          <ArrowRight size={16} className="size-arrow" aria-hidden="true" />
          <div className={`size-box${result ? ' ok' : ''}`}>
            <small>{t('After')}</small>
            <b>{result ? formatBytes(result.sizeAfter) : '—'}</b>
            <div className="size-bar">
              <i style={{ width: result ? `${Math.max(2, Math.min(100, (result.sizeAfter / Math.max(1, sizeBefore)) * 100))}%` : '0%' }} />
            </div>
            {result && <span className="size-saved">−{result.reductionPct}%</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
