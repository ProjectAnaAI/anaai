import { dateLabel } from "../../components/datePresentation";
import { Text, View } from "react-native";
import { DetailLine, PaneTitle, workspaceStyles as ws } from "../../components/workspace";
import { Badge, styles as ui } from "../../components/ui";
import { timeLabel } from "./state";
export function AppointmentSummary({ customer, service, date, time, duration, ready }: {
  customer?: string; service?: string; date: string; time: string; duration?: number | null; ready: boolean;
}) {
  return <View style={ws.railSection}>
    <PaneTitle title="Appointment summary" />
    {ready && <Badge label="Ready to book" tone="success" />}
    <DetailLine icon="user" label="Customer" value={customer || "Not selected"} />
    <DetailLine icon="scissors" label="Service" value={service || "Not selected"} />
    <DetailLine icon="calendar" label="Date" value={date ? dateLabel(date) : "Not selected"} />
    <DetailLine icon="clock" label="Time" value={time ? timeLabel(time) : "Not selected"} />
    {duration != null && <Text style={ui.body}>{duration} minute appointment</Text>}
    <Text style={ui.meta}>Review these details before saving. The time is secured when your appointment is saved.</Text>
  </View>;
}
