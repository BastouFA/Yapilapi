import type { ReactNode, SVGProps } from 'react';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function make(paths: ReactNode, opts: { flipRtl?: boolean } = {}) {
  return function Icon({ size = 20, className, ...rest }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={['yl-icon', opts.flipRtl ? 'yl-icon--flip' : '', className]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

export const HomeIcon = make(
  <>
    <path d="M4 11.2 12 4l8 7.2" />
    <path d="M6 10v9h4.5v-5h3v5H18v-9" />
  </>,
);
export const CompassIcon = make(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m15.5 8.5-2 5-5 2 2-5z" />
  </>,
);
export const PlusIcon = make(
  <>
    <path d="M12 5v14M5 12h14" />
  </>,
);
export const UserIcon = make(
  <>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M5 19.5c.8-3.4 3.7-5 7-5s6.2 1.6 7 5" />
  </>,
);
export const UsersIcon = make(
  <>
    <circle cx="9" cy="9" r="3.2" />
    <path d="M3.5 19c.6-3 3-4.4 5.5-4.4s4.9 1.4 5.5 4.4" />
    <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 14.9c1.8.5 3 1.9 3.3 4.1" />
  </>,
);
export const SettingsIcon = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
  </>,
);
export const HeartIcon = make(
  <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z" />,
);
export const CommentIcon = make(
  <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V15h-.5A1.5 1.5 0 0 1 5 13.5z" />,
  { flipRtl: true },
);
export const BookmarkIcon = make(<path d="M7 4.5h10v15l-5-3.6-5 3.6z" />);
export const ShareIcon = make(
  <>
    <path d="M12 15V4.5M8 8.2l4-3.7 4 3.7" />
    <path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12" />
  </>,
);
export const MoreIcon = make(
  <>
    <circle cx="5.5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.2" fill="currentColor" />
  </>,
);
export const CheckIcon = make(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const CloseIcon = make(<path d="M6 6l12 12M18 6 6 18" />);
export const ChevronDownIcon = make(<path d="m6 9.5 6 6 6-6" />);
export const ChevronUpIcon = make(<path d="m6 14.5 6-6 6 6" />);
export const ChevronEndIcon = make(<path d="m9.5 6 6 6-6 6" />, { flipRtl: true });
export const ChevronStartIcon = make(<path d="m14.5 6-6 6 6 6" />, { flipRtl: true });
export const InfoIcon = make(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8v.01" />
  </>,
);
export const AlertIcon = make(
  <>
    <path d="M12 4.2 3.5 19h17z" />
    <path d="M12 10v4.2M12 16.8v.01" />
  </>,
);
export const GlobeIcon = make(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.4-5.2-3.4-8.5S9.6 5.9 12 3.5z" />
  </>,
);
export const LockIcon = make(
  <>
    <rect x="5.5" y="10.5" width="13" height="9" rx="2.2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </>,
);
export const SunIcon = make(
  <>
    <circle cx="12" cy="12" r="3.8" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
  </>,
);
export const MoonIcon = make(<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />);
export const MonitorIcon = make(
  <>
    <rect x="3.5" y="5" width="17" height="11" rx="2" />
    <path d="M9 19.5h6M12 16v3.5" />
  </>,
);
export const LogoutIcon = make(
  <>
    <path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10" />
    <path d="m14.5 8.5 3.5 3.5-3.5 3.5M18 12H9.5" />
  </>,
  { flipRtl: true },
);
export const LinkIcon = make(
  <>
    <path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.8.8" />
    <path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.8-.8" />
  </>,
);
export const PollIcon = make(
  <>
    <path d="M5 19.5v-7M12 19.5V5M19 19.5v-10" />
  </>,
);
export const PinIcon = make(
  <>
    <path d="M12 20.5s6-5.2 6-10.3a6 6 0 0 0-12 0c0 5.1 6 10.3 6 10.3z" />
    <circle cx="12" cy="10" r="2.2" />
  </>,
);
export const EyeOffIcon = make(
  <>
    <path d="M4 4l16 16" />
    <path d="M9.9 6.2A9.5 9.5 0 0 1 12 6c4.5 0 7.5 4 8.5 6a13 13 0 0 1-2.6 3.3M6.4 7.7A13 13 0 0 0 3.5 12c1 2 4 6 8.5 6 1.2 0 2.3-.3 3.2-.7" />
  </>,
);
export const ThumbDownIcon = make(
  <path d="M8 14V5H5.5A1.5 1.5 0 0 0 4 6.5v5A1.5 1.5 0 0 0 5.5 13H8zm0 0 3.4 6c1.6 0 2.4-1.2 2-2.8L13 14h4.6a1.6 1.6 0 0 0 1.6-2l-1.4-5.4A2 2 0 0 0 15.900 5H8" />,
);
export const SparkIcon = make(
  <path d="M12 3.5 13.8 10 20.5 12 13.8 14 12 20.5 10.200 14 3.500 12 10.200 10z" />,
);
export const TrashIcon = make(
  <>
    <path d="M5 7h14M9.500 7V4.500h5V7M7 7l.8 12.500h8.400L17 7" />
  </>,
);
export const EditIcon = make(
  <>
    <path d="M5 19h3.500L18.500 9a2.100 2.100 0 0 0-3-3L5.500 16z" />
  </>,
);
export const FlagIcon = make(
  <>
    <path d="M6 20V4.500M6 5.500h11l-2.500 3.500L17 12.500H6" />
  </>,
  { flipRtl: true },
);
export const ShieldIcon = make(
  <>
    <path d="M12 3.500 5 6v5.500c0 4.200 2.800 7.200 7 9 4.200-1.800 7-4.800 7-9V6z" />
    <path d="m9 12 2.200 2.200L15 10.500" />
  </>,
);
export const ClockIcon = make(
  <>
    <circle cx="12" cy="12" r="8.500" />
    <path d="M12 7.500V12l3 2" />
  </>,
);
export const BanIcon = make(
  <>
    <circle cx="12" cy="12" r="8.500" />
    <path d="M6 6l12 12" />
  </>,
);
export const SearchIcon = make(
  <>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m20 20-4.3-4.3" />
  </>,
);
export const BellIcon = make(
  <>
    <path d="M6 10.5a6 6 0 0 1 12 0c0 4 1.5 5.500 2 6.500H4c.500-1 2-2.500 2-6.500Z" />
    <path d="M9.700 19.500a2.300 2.300 0 0 0 4.600 0" />
  </>,
);
export const TicketIcon = make(
  <>
    <path d="M4 8.500A2 2 0 0 1 6 6.500h12a2 2 0 0 1 2 2v1a2 2 0 0 0 0 4v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1a2 2 0 0 0 0-4z" />
    <path d="M10 6.500v11" strokeDasharray="2 2" />
  </>,
);
export const MapPinIcon = make(
  <>
    <path d="M12 21s7-6.100 7-11.500A7 7 0 0 0 5 9.500C5 14.900 12 21 12 21Z" />
    <circle cx="12" cy="9.500" r="2.300" />
  </>,
);
export const StoreIcon = make(
  <>
    <path d="M4 9.500 5.200 4.5h13.600L20 9.500" />
    <path d="M4 9.500v9.5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9.500" />
    <path d="M9 19.500v-5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v5" />
  </>,
);
export const ImageIcon = make(
  <>
    <rect x="3.500" y="4.500" width="17" height="15" rx="1.800" />
    <circle cx="8.500" cy="9.500" r="1.700" />
    <path d="m5 17 4.500-5 3.500 3.700L16.500 11 20 15.500" />
  </>,
);
export const VideoIcon = make(
  <>
    <rect x="3.500" y="6.500" width="12" height="11" rx="1.600" />
    <path d="m20.500 9.200-4.500 3 4.500 3z" />
  </>,
);
export const MicIcon = make(
  <>
    <rect x="9" y="3.500" width="6" height="10.500" rx="3" />
    <path d="M6 11.500a6 6 0 0 0 12 0" />
    <path d="M12 17.500v3" />
  </>,
);
export const CalendarIcon = make(
  <>
    <rect x="3.500" y="5" width="17" height="15.500" rx="1.800" />
    <path d="M3.500 10h17M8 3.500v3M16 3.500v3" />
  </>,
);
export const StarIcon = make(
  <path d="m12 4 2.400 5.200 5.600.700-4.200 3.900 1.100 5.700L12 16.700l-4.900 2.800 1.100-5.700-4.200-3.900 5.600-.700z" />,
);
export const FilterIcon = make(<path d="M4 6h16M7 12h10M10.500 18h3" />);
export const BagIcon = make(
  <>
    <path d="M6.500 8h11l1 12.500h-13.500z" />
    <path d="M9 8V6.500a3 3 0 0 1 6 0V8" />
  </>,
);
export const CameraIcon = make(
  <>
    <path d="M4 8h3.200l1.400-2.200h6.800L16.800 8H20a1 1 0 0 1 1 1v9.500a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13.300" r="3.700" />
  </>,
);
export const PeopleIcon = make(
  <>
    <circle cx="8.500" cy="8" r="3" />
    <path d="M2.500 20c0-3.300 2.700-6 6-6s6 2.700 6 6" />
    <circle cx="17" cy="9.500" r="2.400" />
    <path d="M15.700 14.200c2.500.4 4.300 2.500 4.300 5.100" />
  </>,
);
export const CodeIcon = make(
  <>
    <path d="m9 8-5 4 5 4" />
    <path d="m15 8 5 4-5 4" />
  </>,
);
