import React, { useId, useMemo } from 'react';
import { ICON_REGISTRY, type IconName } from './icons.generated';

export interface TGridIconProps
  extends Omit<React.SVGProps<SVGSVGElement>, 'name' | 'width' | 'height' | 'children'> {
  name: IconName;
  size?: number | string;
}

export const TGridIcon: React.FC<TGridIconProps> = ({
  name,
  size = 16,
  className,
  ...rest
}) => {
  const rawUid = useId();
  const entry = ICON_REGISTRY[name];

  const html = useMemo(() => {
    if (!entry) return '';
    if (!entry.hasIds) return entry.body;
    const prefix = `tgi_${rawUid.replace(/[^a-zA-Z0-9_-]/g, '')}_`;
    return entry.body.replaceAll('{{ID}}', prefix);
  }, [entry, rawUid]);

  if (!entry) return null;

  const classes = className ? `tgi tgi-${name} ${className}` : `tgi tgi-${name}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={entry.viewBox}
      width={size}
      height={size}
      fill={entry.fill}
      className={classes}
      aria-hidden={rest['aria-label'] ? undefined : true}
      {...rest}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export interface BrandLogoIconProps
  extends Omit<React.SVGProps<SVGSVGElement>, 'name' | 'width' | 'height' | 'children'> {
  size?: number;
}

export const BrandLogoIcon: React.FC<BrandLogoIconProps> = ({
  size = 20,
  className,
  ...rest
}) => {
  const classes = className ? `brand-icon ${className}` : 'brand-icon';
  return <TGridIcon name="brand-logo" size={size} className={classes} {...rest} />;
};
