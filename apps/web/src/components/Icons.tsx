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
