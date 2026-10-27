import { Link } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';
import { FEATURE_ICONS } from '../components/icons';
import { BrandMark } from '../components/icons/BrandMark';
import { PageHeader } from '../components/ui';
import { APP_DESCRIPTION, APP_NAME, APP_TAGLINE } from '../config/app';
import { BETA_TOOLTIP, featuresByGroup } from '../config/features';
import { t } from '../i18n';

/**
 * The entry point: what the product is, then every feature grouped by the task it
 * performs. Stateless by design - no quick actions, no recent files, nothing
 * stored, so there is nothing here that can go stale.
 */
export function HomePage() {
  return (
    <div className="feature-page">
      <PageHeader icon={BrandMark} title={APP_NAME} description={APP_TAGLINE} />

      <div className="page-body home-page">
        <section className="home-hero" aria-label={t('About this application')}>
          <div className="home-hero-copy">
            <div className="home-hero-brand">
              <BrandLogo size={88} />
              <div className="home-hero-brand-text">
                <h2 className="home-hero-name">{APP_NAME}</h2>
                <p className="home-hero-tagline">{APP_TAGLINE}</p>
              </div>
            </div>
            <p className="home-hero-description">{APP_DESCRIPTION}</p>
          </div>

          <div className="card home-donation-teaser">
            <p className="home-donation-title">
              <FEATURE_ICONS.donation size={22} className="home-donation-icon" />
              {t('Support this app')}
            </p>
            <p className="home-donation-copy">
              {t('{app} is independent, private, and offline software.', { app: APP_NAME })}
            </p>
            <Link to="/donation" className="btn btn-primary btn-sm" id="home-donate">
              {t('Donate')}
            </Link>
          </div>
        </section>

        {featuresByGroup().map((group) => (
          <section key={group.id} className="home-group" aria-labelledby={`home-group-${group.id}`}>
            <h3 className="home-group-title" id={`home-group-${group.id}`}>{group.label}</h3>
            <ul className="home-cards">
              {group.features.map((feature) => {
                const Icon = feature.icon;
                return (
                  <li key={feature.id}>
                    <Link to={feature.route} className="card home-card" id={`home-card-${feature.id}`}>
                      <span className="home-card-head">
                        <span className="home-card-icon" aria-hidden="true">
                          <Icon size={16} strokeWidth={1.9} />
                        </span>
                        <span className="home-card-name">{feature.name}</span>
                        {feature.beta && (
                          <span className="home-card-badge" title={feature.betaNote ?? BETA_TOOLTIP}>BETA</span>
                        )}
                      </span>
                      <span className="home-card-description">{feature.description}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
