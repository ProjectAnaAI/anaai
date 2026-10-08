import { useState } from 'react';
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
import { getAudit, auditMessage } from '../../lib/audit-api';
import { getTimesheetDirectory } from '../../lib/timesheets-api';
import { useManagementScope } from './useManagementScope';
import { useTimeResource } from '../time/useTimeResource';

export function AuditScreen() {
  const management = useManagementScope();

  return (
    <View style={ws.page}>
      <WorkspaceHeader
        title="Audit History"
        business={management.business.name}
        subtitle="Recorded management actions"
      />

      {management.scope ? (
        <Audit
          key={management.scope}
          businessId={management.business.id}
        />
      ) : (
        <Feedback
          title="Management access required"
          detail="Unlock to view audit history."
        />
      )}
    </View>
  );
}

function Audit({ businessId }: { businessId: string }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [employee, setEmployee] = useState('');
  const [category, setCategory] = useState('');
  const [filters, setFilters] = useState<{
    startDate?: string;
    endDate?: string;
    employeeId?: string;
    category?: string;
    cursor?: string;
  }>({});

  const directory = useTimeResource(
    businessId + ':audit-employees',
    (signal) => getTimesheetDirectory(businessId, signal),
  );

  const audit = useTimeResource(
    businessId + JSON.stringify(filters),
    (signal) => getAudit(businessId, filters, signal),
  );

  const main = (
    <>
      <PaneTitle
        title="Chronological history"
        detail="Newest first · Account-only records show an account identifier when no historical name was recorded."
      />

      <Button
        label="Refresh"
        secondary
        onPress={() => {
          directory.refresh();
          audit.refresh();
        }}
      />

      {audit.error ? (
        <Feedback
          kind="error"
          title="History unavailable"
          detail={auditMessage(audit.error)}
          retry={audit.refresh}
        />
      ) : audit.loading ? (
        <Feedback kind="loading" title="Loading history" />
      ) : (
        <>
          {!audit.data?.entries.length && (
            <Feedback title="No recorded actions in this range" />
          )}

          {audit.data?.entries.map((entry) => (
            <View key={entry.id} style={rs.block}>
              <Text style={ui.strong}>
                {entry.action
                  .replaceAll('.', ' · ')
                  .replaceAll('_', ' ')}{' '}
                · {entry.employee_name ?? 'Team report'}
              </Text>

              <Text style={ui.meta}>
                {new Date(entry.recorded_at).toLocaleString()} ·{' '}
                {entry.actor.name ?? `Account ${entry.actor.userId}`} ·{' '}
                {entry.actor.mode === 'shared-device'
                  ? 'PIN-verified employee'
                  : 'Account authority'}
              </Text>

              {entry.reason && (
                <Text style={ui.body}>{entry.reason}</Text>
              )}

              {entry.before_value && (
                <Text style={ui.meta}>
                  Before:{' '}
                  {Object.entries(entry.before_value)
                    .map(
                      ([key, value]) =>
                        `${key.replaceAll('_', ' ')}: ${value ?? 'none'}`,
                    )
                    .join(' · ')}
                </Text>
              )}

              <Text style={ui.meta}>
                After:{' '}
                {Object.entries(entry.after_value)
                  .map(
                    ([key, value]) =>
                      `${key.replaceAll('_', ' ')}: ${value ?? 'none'}`,
                  )
                  .join(' · ')}
              </Text>

              {entry.correction_id && (
                <Text style={ui.meta}>
                  Correction reference: {entry.correction_id}
                </Text>
              )}

              {entry.issue_id && (
                <Text style={ui.meta}>
                  Issue reference: {entry.issue_id}
                </Text>
              )}

              {entry.pin_reset && (
                <Text style={ui.meta}>
                  PIN was reset; credential values are never recorded.
                </Text>
              )}
            </View>
          ))}

          <View style={rs.actions}>
            {filters.cursor && (
              <Button
                label="First page"
                secondary
                onPress={() =>
                  setFilters({
                    ...filters,
                    cursor: undefined,
                  })
                }
              />
            )}

            {audit.data?.nextCursor && (
              <Button
                label="Next page"
                secondary
                onPress={() =>
                  setFilters({
                    ...filters,
                    cursor: audit.data!.nextCursor!,
                  })
                }
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
        title="Filters"
        detail="Dates are business-local. Default: last 30 days."
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
        {['', 'team', 'time', 'reports'].map((value) => (
          <Button
            key={value}
            label={value || 'All categories'}
            secondary
            disabled={category === value}
            onPress={() => setCategory(value)}
          />
        ))}
      </View>

      <Button
        label="All authorized employees"
        secondary
        disabled={!employee}
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
            disabled={employee === entry.id}
            onPress={() => setEmployee(entry.id)}
          />
        ))
      )}

      <Button
        label="Apply filters"
        onPress={() =>
          setFilters({
            startDate: start || undefined,
            endDate: end || undefined,
            employeeId: employee || undefined,
            category: category || undefined,
          })
        }
      />
    </>
  );

  return <SplitWorkspace main={main} rail={rail} />;
}
