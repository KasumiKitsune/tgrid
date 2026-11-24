import React from 'react';
import {
  BrandLogoIcon,
  ICON_NAMES,
  TGridIcon,
  type IconName
} from '@tgrid/icons';

export { BrandLogoIcon, ICON_NAMES, TGridIcon, type IconName };

export const ChevronIcon: React.FC<{ size?: number }> = ({ size = 11 }) => (
  <TGridIcon name="ChevronIcon" size={size} className="chev" />
);

export const CloseIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <TGridIcon name="CloseIcon" size={size} />
);

export const InfoIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    className="ui-icon"
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 7.2 V11.1" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    <circle cx="8" cy="5.05" r="0.85" fill="currentColor" />
  </svg>
);

export const ExternalLinkIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    className="ui-icon"
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M6.4 3.4 H3.6 C2.94 3.4 2.4 3.94 2.4 4.6 V12.4 C2.4 13.06 2.94 13.6 3.6 13.6 H11.4 C12.06 13.6 12.6 13.06 12.6 12.4 V9.6"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9.4 2.4 H13.6 V6.6"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M13.4 2.6 L7.6 8.4"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

export const UiIcon: React.FC<{ name: IconName; size?: number; className?: string }> = ({
  name,
  size = 14,
  className
}) => (
  <TGridIcon
    name={name}
    size={size}
    className={className ? `ui-icon ${className}` : 'ui-icon'}
  />
);
