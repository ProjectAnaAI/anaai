import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { Button, styles as ui } from '../../components/ui';
import {
  LabeledField,
  recordStyles as rs,
} from '../../components/records';
import {
  Feedback,
  SplitWorkspace,
  PaneTitle,
  WorkspaceHeader,
  workspaceStyles as ws,
} from '../../components/workspace';
import {
  getTimeReport,
  exportTimeReport,
  reportMessage,
  type ReportFilters,
} from '../../lib/time-reports-api';
import { ZudeApiError } from '../../lib/api';
import { shareTimeReport } from '../../lib/share-time-report';
import { getTimesheetDirectory } from '../../lib/timesheets-api';
import { useManagementScope } from './useManagementScope';
import { useTimeResource } from '../time/useTimeResource';
import { formatDuration } from '../time/state';

export function ReportsScreen() {
  const management = useManagementScope();

  return (
    <View style={ws.page}>
      <WorkspaceHeader
        title="Time Reports"
        business={management.business.name}
        subtitle="Recorded time · No payroll calculations"
      />

      {management.scope ? (
        <Reports
          key={management.scope}
          businessId={management.business.id}
          userId={management.userId!}
        />
      ) : (
        <Feedback
          title="Management access required"
          detail="Unlock to view and export time reports."
        />
      )}
    </View>
  );
}

function Reports({
  businessId,
  userId,
}: {
  businessId: string;
  userId: string;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [employee, setEmployee] = useState('');
  const [grouping, setGrouping] =
    useState<NonNullable<ReportFilters['grouping']>>('employee');
  const [filters, setFilters] = useState<ReportFilters>({});
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const alive = useRef(true);
  const submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);

  const directory = useTimeResource(
    businessId + ':report-employees',
    (signal) => getTimesheetDirectory(businessId, signal),
  );

  const report = useTimeResource(
    businessId + JSON.stringify(filters),
    (signal) => getTimeReport(businessId, filters, signal),
  );

  const view = !report.loading && !report.error ? report.data : null;
  // An authority refresh can reduce the result while retaining the selection.
  const visiblePage = Math.min(page, Math.max(0, Math.ceil((view?.rows.length ?? 0) / 100) - 1));

  const exportFile = async () => {
    if (submitting.current) {
      return;
    }

    submitting.current = true;
    setBusy(true);
    setMessage(null);

    const currentController = new AbortController();
    controller.current = currentController;

    try {
      const result = await exportTimeReport(
        businessId,
        userId,
        filters,
        currentController.signal,
      );

      if (!alive.current || currentController.signal.aborted) {
        return;
      }

      setPage(0);
      report.replace(result.report);

      await shareTimeReport(
        result.csv,
        result.filename,
        currentController.signal,
      );

      if (alive.current) {
        setMessage(
          'Export prepared and audited. The share dialog may be saved or dismissed.',
        );
      }
    } catch (error) {
      if (alive.current) {
        setMessage(reportMessage(error));

        if (
          error instanceof ZudeApiError &&
          [401, 403, 404].includes(error.status)
        ) {
          setStart('');
          setEnd('');
          setEmployee('');
          report.refresh();
          directory.refresh();
        }
      }
    } finally {
      if (alive.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  };

  const main = (
    <>
      <PaneTitle
        title="Report summary"
        detail={
          view
            ? `${view.range.startDate} – ${view.range.endDate} · ${view.timezone}`
            : 'Default: last 30 business-local days'
        }
      />

      <View style={rs.actions}>
        <Button
          label="Refresh"
          secondary
          disabled={busy}
          onPress={() => {
            setPage(0);
            setMessage(null);
            report.refresh();
            directory.refresh();
          }}
        />

        <Button
          label={busy ? 'Preparing CSV…' : 'Export / share CSV'}
          disabled={busy || !view}
          onPress={() => void exportFile()}
        />
      </View>

      {message && (
        <Text accessibilityRole="alert" style={ui.body}>
          {message}
        </Text>
      )}

      {report.error ? (
        <Feedback
          kind="error"
          title="Report unavailable"
          detail={reportMessage(report.error)}
          retry={report.refresh}
        />
      ) : !view ? (
        <Feedback kind="loading" title="Loading authoritative time" />
      ) : (
        <>
          <Text style={ui.strong}>
            {formatDuration(view.totals.workedMs)} worked
          </Text>

          <Text style={ui.meta}>
            Paid breaks: {formatDuration(view.totals.paidBreakMs)} · Meal
            breaks: {formatDuration(view.totals.mealBreakMs)}
          </Text>

          <Text style={ui.meta}>
            Snapshot: {new Date(view.snapshotAt).toLocaleString()}
            {view.totals.open ? ' · Includes open intervals' : ''}
          </Text>

          {view.totals.corrected && (
            <Text style={ui.meta}>
              Includes employees with correction history. Totals use current
              effective time.
            </Text>
          )}

          <Text style={ui.meta}>
            Rows{' '}
            {view.rows.length
              ? `${visiblePage * 100 + 1}–${Math.min(
                  (visiblePage + 1) * 100,
                  view.rows.length,
                )}`
              : '0'}{' '}
            of {view.rows.length}. CSV includes daily employee records.
          </Text>

          {view.rows
            .slice(visiblePage * 100, (visiblePage + 1) * 100)
            .map((row, index) => (
              <View
                key={`${row.employeeId}:${row.date}:${row.week}:${index}`}
                style={rs.block}
              >
                <Text style={ui.strong}>
                  {row.employee} {row.date ?? row.week ?? ''}
                </Text>

                <Text style={ui.body}>
                  {formatDuration(row.workedMs)} worked · Paid{' '}
                  {formatDuration(row.paidBreakMs)} · Meal{' '}
                  {formatDuration(row.mealBreakMs)}
                </Text>

                <Text style={ui.meta}>
                  {row.open ? 'Open interval · ' : ''}
                  {row.corrected ? 'Employee has correction history' : ''}
                </Text>
              </View>
            ))}

          <View style={rs.actions}>
            {visiblePage > 0 && (
              <Button
                label="Previous rows"
                secondary
                onPress={() => setPage(visiblePage - 1)}
              />
            )}

            {(visiblePage + 1) * 100 < view.rows.length && (
              <Button
                label="Next rows"
                secondary
                onPress={() => setPage(visiblePage + 1)}
              />
            )}
          </View>
        </>
      )}
    </>
  );

  const rail = (
    <>
      <PaneTitle
        title="Report filters"
        detail="Up to 93 local days. CSV always includes daily employee records in this range."
      />

      <LabeledField
        label="Start date (YYYY-MM-DD)"
        value={start}
        onChangeText={setStart}
      />

      <LabeledField
        label="End date (YYYY-MM-DD)"
        value={end}
        onChangeText={setEnd}
      />

      <View style={rs.actions}>
        {(['employee', 'day', 'week', 'team'] as const).map((value) => (
          <Button
            key={value}
            label={value}
            secondary
            disabled={grouping === value || busy}
            onPress={() => setGrouping(value)}
          />
        ))}
      </View>

      <Button
        label="All authorized employees"
        secondary
        disabled={!employee || busy}
        onPress={() => setEmployee('')}
      />

      {directory.error ? (
        <Feedback
          kind="error"
          title="Employee filters unavailable"
          retry={directory.refresh}
        />
      ) : (
        !directory.loading &&
        directory.data?.employees.map((entry) => (
          <Button
            key={entry.id}
            label={entry.name}
            secondary
            disabled={employee === entry.id || busy}
            onPress={() => setEmployee(entry.id)}
          />
        ))
      )}

      <Button
        label="Apply filters"
        disabled={busy}
        onPress={() => {
          setPage(0);
          setMessage(null);
          setFilters({
            startDate: start || undefined,
            endDate: end || undefined,
            employeeId: employee || undefined,
            grouping,
          });
        }}
      />
    </>
  );

  return <SplitWorkspace main={main} rail={rail} />;
}
