import { Heart } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { APP_DESCRIPTION, APP_NAME, APP_TAGLINE } from '../config/app';
import { featuresByGroup } from '../config/features';

/**
 * The entry point: what the product is, then every feature grouped by the task it
 * performs. Stateless by design - no quick actions, no recent files, nothing
 * stored, so there is nothing here that can go stale.
 */
export function HomePage() {
  return (
    <div className="feature-page">
      <PageHeader icon={Heart} title={APP_NAME} description={APP_TAGLINE} />

      <div className="page-body home-page">
        <section className="home-hero" aria-label="About this application">
          <div className="card home-hero-copy">
            <h2 className="home-hero-name">{APP_NAME}</h2>
            <p className="home-hero-tagline">{APP_TAGLINE}</p>
            <p className="home-hero-description">{APP_DESCRIPTION}</p>
          </div>

          <div className="card home-donation-teaser">
            <Heart size={18} className="home-donation-icon" aria-hidden="true" />
            <p className="home-donation-title">Support this app</p>
            <Link to="/donation" className="btn btn-primary btn-sm" id="home-donate">
              Donate
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
                      <Icon size={20} className="home-card-icon" aria-hidden="true" />
                      <span className="home-card-name">{feature.name}</span>
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
