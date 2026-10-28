import { useEffect, useState } from 'react';
import { ArrowLeft, Scale } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader, Tabs } from '../components/ui';
import { APP_LICENSE_NAME, APP_LICENSE_URL, APP_NAME, APP_SOURCE_URL } from '../config/app';
import { t } from '../i18n';

type Section = 'dokuwu' | 'third-party';

/** The license texts are large, so they load only when this page opens. */
const LOADERS: Record<Section, () => Promise<{ default: string }>> = {
  dokuwu: () => import('../assets/legal/LICENSE.txt?raw'),
  'third-party': () => import('../assets/legal/THIRD-PARTY-NOTICES.txt?raw'),
};

/**
 * The legal notices: Dokuwu's own license (GNU AGPL) and the licenses of the
 * components it is built from. Plain text, so what is shown is the file itself.
 */
export function LicensesPage() {
  const [section, setSection] = useState<Section>('dokuwu');
  const [texts, setTexts] = useState<Partial<Record<Section, string>>>({});
  const [failed, setFailed] = useState<Partial<Record<Section, boolean>>>({});

  useEffect(() => {
    if (texts[section] !== undefined || failed[section]) return;
    let cancelled = false;
    LOADERS[section]()
      .then((module) => {
        if (!cancelled) setTexts((current) => ({ ...current, [section]: module.default }));
      })
      .catch(() => {
        if (!cancelled) setFailed((current) => ({ ...current, [section]: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [section, texts, failed]);

  const text = texts[section];

  return (
    <div className="feature-page">
      <PageHeader
        icon={Scale}
        title={t('Licenses')}
        description={t('The license of {app} and of the software it is built from', { app: APP_NAME })}
        actions={(
          <Link className="btn btn-secondary" to="/settings" id="licenses-back">
            <ArrowLeft size={14} aria-hidden="true" /> {t('Settings')}
          </Link>
        )}
      />
      <Tabs
        ariaLabel={t('Licenses')}
        value={section}
        onChange={setSection}
        items={[
          { value: 'dokuwu', label: APP_NAME, id: 'licenses-tab-dokuwu', controls: 'licenses-panel' },
          { value: 'third-party', label: t('Third-party software'), id: 'licenses-tab-third-party', controls: 'licenses-panel' },
        ]}
      />
      <div className="page-body">
        <div className="licenses-page">
          <p className="licenses-intro">
            {section === 'dokuwu'
              ? t('{app} is free software under the {license}. It comes with ABSOLUTELY NO WARRANTY. The full source code is at {source}.', {
                app: APP_NAME, license: APP_LICENSE_NAME, source: APP_SOURCE_URL,
              })
              : t('{app} is built from the open-source components below. Each keeps its own license and copyright.', { app: APP_NAME })}
            {section === 'dokuwu' && (
              <>
                {' '}
                <a className="link-btn" href={APP_LICENSE_URL} target="_blank" rel="noreferrer">
                  {t('Read it online')}
                </a>
              </>
            )}
          </p>
          <pre
            className="licenses-text"
            id="licenses-panel"
            role="tabpanel"
            aria-labelledby={`licenses-tab-${section}`}
            tabIndex={0}
          >
            {text ?? (failed[section] ? t('Could not load the license text.') : t('Loading…'))}
          </pre>
        </div>
      </div>
    </div>
  );
}
