"use client";

import { useRouter } from "next/navigation";
import { CalendarPlus, UserPlus, PlusCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function QuickActions() {
  const router = useRouter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick actions</CardTitle>
      </CardHeader>

      <CardContent className="flex flex-wrap gap-3">
        <Button onClick={() => router.push("/appointments")}>
          <CalendarPlus className="mr-2 h-4 w-4" />
          New appointment
        </Button>

        <Button variant="outline" onClick={() => router.push("/customers")}>
          <UserPlus className="mr-2 h-4 w-4" />
          New customer
        </Button>

        <Button variant="outline" onClick={() => router.push("/services")}>
          <PlusCircle className="mr-2 h-4 w-4" />
          New service
        </Button>
      </CardContent>
    </Card>
  );
}