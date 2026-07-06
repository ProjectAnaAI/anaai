import { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

type StatsCardProps = {
  title: string;
  value: string | number;
  description?: string;
  icon: LucideIcon;
};

export default function StatsCard({
  title,
  value,
  description,
  icon: Icon,
}: StatsCardProps) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-gray-500">{title}</p>

            <p className="mt-3 text-3xl font-semibold tracking-tight text-gray-900">
              {value}
            </p>

            {description && (
              <p className="mt-2 text-sm text-gray-500">{description}</p>
            )}
          </div>

          <div className="rounded-xl bg-green-50 p-3 text-green-600">
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}