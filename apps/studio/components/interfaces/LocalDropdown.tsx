import { useTheme } from "next-themes";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  singleThemes,
} from "ui";

import { ButtonTooltip } from "../ui/ButtonTooltip";
import { ProfileImage } from "@/components/ui/ProfileImage";
import { useTrack } from "@/lib/telemetry/track";

export const LocalDropdown = ({
  triggerClassName,
  contentClassName,
}: {
  triggerClassName?: string;
  contentClassName?: string;
}) => {
  const { theme, setTheme } = useTheme();
  const track = useTrack();

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) track("header_local_dropdown_opened");
      }}
    >
      <DropdownMenuTrigger
        className={cn("border shrink-0 px-3", triggerClassName)}
        asChild
      >
        <ButtonTooltip
          variant="default"
          className="[&>span]:flex px-0 py-0 rounded-full overflow-hidden h-8 w-8"
          tooltip={{ content: { text: "Settings" } }}
        >
          <ProfileImage className="w-8 h-8 rounded-md" />
          <span className="sr-only">Settings</span>
        </ButtonTooltip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        className={cn("w-44", contentClassName)}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => {
              setTheme(value);
            }}
          >
            {singleThemes.map((theme) => (
              <DropdownMenuRadioItem
                key={theme.value}
                value={theme.value}
                className="cursor-pointer"
              >
                {theme.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
