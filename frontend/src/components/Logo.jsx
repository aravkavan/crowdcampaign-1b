export default function Logo({ inverted = false }) {
  return (
    <span className={`logo ${inverted ? 'logo-inverted' : ''}`}>
      <svg className="logo-mark" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
        <rect width="32" height="32" rx="9" className="logo-tile" />
        <path d="M8 13.4h5.2L20 8.6v14.8l-6.8-4.8H8z" className="logo-horn" />
        <path d="M23.2 12.2c1.3 1 2 2.3 2 3.8s-.7 2.8-2 3.8" className="logo-wave" />
      </svg>
      <span className="logo-word">CrowdCampaign</span>
    </span>
  );
}
