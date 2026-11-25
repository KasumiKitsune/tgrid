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

export const ShortcutsIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 16,
  className
}) => (
  <TGridIcon
    name="shortcuts"
    size={size}
    className={className ? `ui-icon ${className}` : 'ui-icon'}
  />
);

export const SubmenuChevronIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 12,
  className
}) => (
  <TGridIcon
    name="submenuChevron"
    size={size}
    className={className ? `ui-icon ${className}` : 'ui-icon'}
  />
);

export const InfoIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 16,
  className
}) => (
  <TGridIcon
    name="info"
    size={size}
    className={className ? `ui-icon ${className}` : 'ui-icon'}
  />
);

export const ExternalLinkIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 12,
  className
}) => (
  <TGridIcon
    name="externalLink"
    size={size}
    className={className ? `ui-icon ${className}` : 'ui-icon'}
  />
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
