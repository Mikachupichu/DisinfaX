import React from 'react';

interface DisclaimerProps {
  template: string;
  buttonLabel?: string;
  buttonIcon?: React.ReactNode;
  className?: string;
}

export const Disclaimer: React.FC<DisclaimerProps> = ({
  template,
  buttonLabel,
  buttonIcon,
  className = 'text-[11px] text-zinc-500 leading-normal text-center px-2',
}) => {
  if (!template) return null;

  const parts = template.split('%BTN%');

  return (
    <div className={className}>
      {parts[0]}
      {parts.length > 1 && (
        <>
          {buttonIcon ? (
            <span className="inline-flex items-center align-middle mx-1 text-zinc-300">
              {buttonIcon}
            </span>
          ) : buttonLabel ? (
            <span className="font-bold text-zinc-300">
              “{buttonLabel}”
            </span>
          ) : null}
          {parts.slice(1).join('%BTN%')}
        </>
      )}
    </div>
  );
};
