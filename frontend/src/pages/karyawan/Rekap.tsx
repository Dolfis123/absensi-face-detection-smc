import { useMemo, useState } from 'react';
import { DaysTable, SummaryGrid, useLoad } from '../../components/attendance';
import { Alert, Card, Input, Loading, PageHeader } from '../../components/ui';
import { api, EmployeeRecap } from '../../lib/api';
import { todayWIT } from '../../lib/format';

export default function Rekap() {
  const [month, setMonth] = useState(todayWIT().slice(0, 7));
  const { data, error, loading } = useLoad(
    () => api.get<EmployeeRecap & { month: string }>(`/me/recap?month=${month}`),
    [month],
  );

  // Filter 7 hari ke depan (termasuk hari ini)
  const upcomingDays = useMemo(() => {
    if (!data?.days) return [];
    
    const today = new Date(todayWIT());
    today.setHours(0, 0, 0, 0);

    const targetEnd = new Date(today);
    targetEnd.setDate(today.getDate() + 6); // Hari ini + 6 hari = total 7 hari
    targetEnd.setHours(23, 59, 59, 999);

    return data.days.filter((item) => {
      const itemDate = new Date(item.date);
      return itemDate >= today && itemDate <= targetEnd;
    });
  }, [data]);

  return (
    <>
      <PageHeader
        title="Rekap Kehadiran"
        subtitle="Data terkunci dari sistem. Ajukan laporan kendala bila ada yang tidak sesuai."
        actions={<Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" />}
      />
      {error && <Alert>{error}</Alert>}
      {loading && <Loading />}
      {data && !loading && (
        <div className="space-y-4">
          <SummaryGrid summary={data.summary} />
          <Card>
            <DaysTable days={upcomingDays} />
            <p className="mt-3 text-xs text-slate-400">* = hasil koreksi resmi Super Admin (tercatat di audit trail)</p>
          </Card>
        </div>
      )}
    </>
  );
}