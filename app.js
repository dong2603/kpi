window.onerror = function(message, source, lineno, colno, error) {
    fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: message,
            source: source,
            line: lineno,
            col: colno,
            stack: error ? error.stack : ''
        })
    }).catch(err => console.warn("Logging failed", err));
    return false;
};

// Global variables to store dashboard data and chart instances
let dashboardData = null;
let charts = {};

// Default sheets API url
const API_URL = '/api/court-data';

document.addEventListener('DOMContentLoaded', () => {
    try { initAuthScreen(); } catch (e) { console.error("initAuthScreen failed:", e); }
    try { initTabNavigation(); } catch (e) { console.error("initTabNavigation failed:", e); }
    try { initSyncButton(); } catch (e) { console.error("initSyncButton failed:", e); }
    try { initTableFilters(); } catch (e) { console.error("initTableFilters failed:", e); }
    try { initGlobalFilters(); } catch (e) { console.error("initGlobalFilters failed:", e); }
});

function initAuthScreen() {
    const authScreen = document.getElementById('auth-screen');
    const dashboardContainer = document.getElementById('dashboard-container');
    const passwordInput = document.getElementById('auth-password');
    const submitBtn = document.getElementById('auth-submit');
    const errorMsg = document.getElementById('auth-error');
    
    if (!authScreen || !dashboardContainer) return;
    
    // 이미 세션 인증 정보가 있으면 즉시 접속
    if (sessionStorage.getItem('dashboard_auth') === 'true') {
        authScreen.style.display = 'none';
        dashboardContainer.style.display = 'block';
        loadDashboardData(false);
        return;
    }
    
    // 인증 전에는 로딩 오버레이 비활성화
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.classList.remove('active');
    }
    
    passwordInput.focus();
    
    function verifyPassword() {
        const password = passwordInput.value.trim();
        if (password === '801300') {
            sessionStorage.setItem('dashboard_auth', 'true');
            authScreen.style.display = 'none';
            dashboardContainer.style.display = 'block';
            
            // 대시보드 로드 시 로딩 화면 띄우기
            if (loadingOverlay) {
                loadingOverlay.classList.add('active');
            }
            loadDashboardData(false);
        } else {
            errorMsg.textContent = '비밀번호가 올바르지 않습니다. 다시 입력해주세요.';
            passwordInput.value = '';
            passwordInput.focus();
        }
    }
    
    submitBtn.addEventListener('click', verifyPassword);
    passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            verifyPassword();
        }
    });
}


// Global Filters Change Event Listeners
function initGlobalFilters() {
    const filterIds = [
        'filter-data-type',
        'filter-global-manager',
        'filter-global-platform',
        'filter-global-sanction',
        'filter-global-month',
        'filter-global-day'
    ];
    
    filterIds.forEach(id => {
        const filter = document.getElementById(id);
        if (filter) {
            filter.addEventListener('change', () => {
                // If year_month changes, let's reset day select to "전체 일" to avoid date mismatch
                if (id === 'filter-global-month') {
                    const dayFilter = document.getElementById('filter-global-day');
                    if (dayFilter) dayFilter.value = '';
                }
                loadDashboardData(false); // Reload with selected filters, no force download
            });
        }
    });
}

// 1. Sidebar Tab Navigation
function initTabNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const tabContents = document.querySelectorAll('.tab-content');
    
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Remove active from all nav items and tabs
            navItems.forEach(nav => nav.classList.remove('active'));
            tabContents.forEach(tab => tab.classList.remove('active'));
            
            // Set active
            item.classList.add('active');
            const tabId = `tab-${item.getAttribute('data-tab')}`;
            const targetTab = document.getElementById(tabId);
            if (targetTab) {
                targetTab.classList.add('active');
            }
            
            // Trigger chart redraw to fix dimension bugs on hidden containers
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
            }, 100);
        });
    });
}

// 2. Sync Button Handler (Background Asynchronous Sync)
function initSyncButton() {
    const btnSync = document.getElementById('btn-sync');
    if (!btnSync) return;
    
    btnSync.addEventListener('click', async () => {
        const syncIcon = document.querySelector('.sync-icon');
        const sheetUrl = document.getElementById('sheet-url')?.value || '';
        
        if (btnSync.classList.contains('syncing')) {
            showToast('이미 구글 시트 최신 데이터 동기화가 진행 중입니다.', 'info');
            return;
        }
        
        btnSync.classList.add('syncing');
        if (syncIcon) syncIcon.classList.add('loading');
        
        showToast('실시간 동기화를 시작합니다. 구글 시트에서 최신 데이터를 가져오는 중입니다 (약 3~5초 소요)...', 'info');
        
        try {
            const syncUrl = `/api/sync?url=${encodeURIComponent(sheetUrl)}`;
            const res = await fetch(syncUrl, { method: 'POST' });
            const result = await res.json();
            
            if (!result.success) {
                throw new Error(result.message || '동기화 시작 실패');
            }
            
            // Poll status every 3 seconds
            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch('/api/sync-status');
                    const statusData = await statusRes.json();
                    
                    if (!statusData.in_progress) {
                        clearInterval(pollInterval);
                        btnSync.classList.remove('syncing');
                        if (syncIcon) syncIcon.classList.remove('loading');
                        
                        if (statusData.info && statusData.info.status === 'success') {
                            showToast('최신 데이터 동기화가 완료되었습니다! 대시보드를 갱신합니다.', 'success');
                            // Update sync time text
                            const syncTimeEl = document.getElementById('sync-time');
                            if (syncTimeEl && statusData.info.updated_at) {
                                syncTimeEl.textContent = `갱신 시간: ${statusData.info.updated_at}`;
                            }
                            // Reload dashboard with fresh cached data
                            loadDashboardData(false);
                        } else if (statusData.info && statusData.info.status === 'error') {
                            showToast(statusData.info.message || '동기화 중 오류가 발생했습니다.', 'error');
                        }
                    }
                } catch (pollErr) {
                    console.error('Sync polling error:', pollErr);
                }
            }, 3000);
            
        } catch (err) {
            btnSync.classList.remove('syncing');
            if (syncIcon) syncIcon.classList.remove('loading');
            showToast(`동기화 요청 실패: ${err.message}`, 'error');
        }
    });
}

// 3. Load Dashboard Data from Flask API
async function loadDashboardData(force = false) {
    const sheetUrl = document.getElementById('sheet-url').value;
    const syncIcon = document.querySelector('.sync-icon');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    
    // Read filter values
    const dataType = document.getElementById('filter-data-type')?.value || '';
    const manager = document.getElementById('filter-global-manager')?.value || '';
    const platform = document.getElementById('filter-global-platform')?.value || '';
    const sanctionType = document.getElementById('filter-global-sanction')?.value || '';
    const yearMonth = document.getElementById('filter-global-month')?.value || '';
    const day = document.getElementById('filter-global-day')?.value || '';
    
    // UI Loading state - only show full overlay on force sync or first load
    const isFirstLoad = !dashboardData;
    if (syncIcon) syncIcon.classList.add('loading');
    if (force || isFirstLoad) {
        if (loadingOverlay) loadingOverlay.classList.add('active');
        if (loadingText) loadingText.textContent = force ? "실시간 구글 시트 데이터를 다운로드 및 분석 중..." : "데이터 연산 및 시각화 중...";
    }
    
    try {
        let fetchUrl = `${API_URL}?url=${encodeURIComponent(sheetUrl)}&force=${force}`;
        if (dataType) fetchUrl += `&data_type=${encodeURIComponent(dataType)}`;
        if (manager) fetchUrl += `&manager=${encodeURIComponent(manager)}`;
        if (platform) fetchUrl += `&platform=${encodeURIComponent(platform)}`;
        if (sanctionType) fetchUrl += `&sanction_type=${encodeURIComponent(sanctionType)}`;
        if (yearMonth) fetchUrl += `&year_month=${encodeURIComponent(yearMonth)}`;
        if (day) fetchUrl += `&day=${encodeURIComponent(day)}`;
        
        const response = await fetch(fetchUrl);
        
        // JSON 응답이 아닌 경우 방어 처리
        const contentType = response.headers.get("content-type");
        if (!response.ok || !contentType || !contentType.includes("application/json")) {
            const errText = await response.text();
            throw new Error(`서버 에러 (${response.status}): ${errText.substring(0, 100)}`);
        }
        
        const data = await response.json();
        
        if (data.success) {
            dashboardData = data;
            
            // Update UI components
            updateKpiCards(data.summary);
            updateAllGlobalFilters(data);
            renderCharts(data);
            renderTables(data);
            populateFilters(data.manager_stats);
            
            // Update last sync time
            updateLastSyncTime();
            
            if (force) {
                showToast("데이터 동기화 완료!", "fa-circle-check", "#00e676");
            }
        } else {
            console.error("API error:", data.error);
            showToast(`동기화 실패: ${data.error}`, "fa-circle-exclamation", "#ff1744");
        }
    } catch (error) {
        console.error("Fetch error:", error);
        showToast(`서버 접속 실패: ${error.message}`, "fa-circle-xmark", "#ff1744");
    } finally {
        // UI Reset loading state
        if (syncIcon) syncIcon.classList.remove('loading');
        if (loadingOverlay) loadingOverlay.classList.remove('active');
    }
}

function updateAllGlobalFilters(data) {
    // 2. 담당자
    updateFilterDropdown(
        'filter-global-manager', 
        data.available_managers, 
        data.selected_manager || '', 
        '전체 담당자'
    );
    
    // 3. 플랫폼
    updateFilterDropdown(
        'filter-global-platform', 
        data.available_platforms, 
        data.selected_platform || '', 
        '전체 플랫폼'
    );
    
    // 4. 제재 구분
    updateFilterDropdown(
        'filter-global-sanction', 
        data.available_sanctions, 
        data.selected_sanction || '', 
        '전체'
    );
    
    // 5. 월 선택
    updateFilterDropdown(
        'filter-global-month', 
        data.available_months, 
        data.selected_month || '', 
        '전체 월',
        m => {
            const parts = m.split('-');
            return `${parts[0]}년 ${parts[1]}월`;
        }
    );
    
    // 6. 일자 선택
    updateFilterDropdown(
        'filter-global-day', 
        data.available_days, 
        data.selected_day || '', 
        '전체 일',
        d => `${d}일`
    );
}

function updateFilterDropdown(elementId, items, selectedValue, defaultLabel, labelFormatter = null) {
    const filter = document.getElementById(elementId);
    if (!filter) return;
    
    const currentVal = filter.value;
    const activeVal = selectedValue || currentVal;
    
    // Check if options are already populated and match exactly
    const currentOptions = Array.from(filter.options).map(o => o.value).filter(v => v !== '');
    const itemsStr = items.map(x => String(x));
    const isSame = currentOptions.length === itemsStr.length && currentOptions.every((v, i) => v === itemsStr[i]);
    
    if (!isSame) {
        filter.innerHTML = `<option value="">${defaultLabel}</option>`;
        items.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item;
            opt.textContent = labelFormatter ? labelFormatter(item) : item;
            filter.appendChild(opt);
        });
    }
    
    filter.value = activeVal;
    
    if (filter.selectedIndex === -1) {
        filter.value = '';
    }
}

// 4. Update KPI Card displays
function updateKpiCards(summary) {
    const totalInspectedVal = summary.total_inspected;
    const totalSanctionsVal = summary.total_sanctions;
    const sanctionRateVal = summary.sanction_rate;
    const avgDurationSecVal = summary.avg_duration_sec;
    
    const cardInspectedVal = document.getElementById('val-total-inspected');
    const cardInspectedSub = document.getElementById('sub-total-inspected');
    const cardSanctionsVal = document.getElementById('val-total-sanctions');
    const cardSanctionsSub = document.getElementById('sub-total-sanctions');
    const cardDurationVal = document.getElementById('val-avg-duration');
    const cardDurationSub = document.getElementById('sub-avg-duration');
    
    let monthLabel = "전체 기간";
    if (dashboardData && dashboardData.selected_month) {
        const parts = dashboardData.selected_month.split('-');
        monthLabel = `${parseInt(parts[1])}월 누적`;
    } else {
        monthLabel = "누적 전체";
    }
    
    if (cardInspectedVal) cardInspectedVal.textContent = totalInspectedVal.toLocaleString() + " 건";
    if (cardInspectedSub) cardInspectedSub.textContent = `${monthLabel} 완료 건수`;
    
    if (cardSanctionsVal) cardSanctionsVal.textContent = totalSanctionsVal.toLocaleString() + " 건";
    if (cardSanctionsSub) cardSanctionsSub.textContent = `실제 제재 성공률: ${sanctionRateVal.toFixed(1)}%`;
    
    if (cardDurationVal) cardDurationVal.textContent = formatSecondsToMinSec(avgDurationSecVal);
    if (cardDurationSub) {
        cardDurationSub.textContent = `평균 소요 시간: ${Math.round(avgDurationSecVal)}초 (${totalInspectedVal.toLocaleString()}건 분석)`;
    }
}

function formatSecondsToMinSec(sec) {
    if (!sec || isNaN(sec)) return "0초";
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m > 0) {
        return `${m}분 ${s}초`;
    }
    return `${s}초`;
}

function updateLastSyncTime() {
    const el = document.getElementById('last-sync-time');
    if (!el) return;
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    el.textContent = `갱신 시간 : ${yyyy}.${mm}.${dd} ${hh}:${mi}`;
}

// 5. Populate table filters
function populateFilters(managers) {
    const filterManager = document.getElementById('filter-manager');
    if (!filterManager) return;
    
    // Save current selection
    const currentSelected = filterManager.value;
    
    // Reset to default option
    filterManager.innerHTML = '<option value="">전체 담당자</option>';
    
    // Sort manager names
    const sortedNames = managers.map(m => m.manager).sort();
    sortedNames.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        filterManager.appendChild(opt);
    });
    
    // Restore selection
    filterManager.value = currentSelected;
}

// 6. Chart Renderings (ApexCharts)
function renderCharts(data) {
    const themeMode = 'dark';
    
    // --- Chart 1: Daily Trend (Solid & Dashed Line Chart) ---
    try {
        const dailyData = data.daily_trend;
        const dailyDates = dailyData.map(d => {
            const parts = d.date.split('-');
            if (parts.length >= 3) {
                return `${parts[1]}/${parts[2]}`;
            }
            return d.date;
        });
        const dailyInspected = dailyData.map(d => d.inspected);
        const dailySanctioned = dailyData.map(d => d.sanctioned);
        
        const dailyTrendOptions = {
            series: [
                {
                    name: '총 검수 건수',
                    type: 'line',
                    data: dailyInspected
                },
                {
                    name: '제재 조치 건수',
                    type: 'line',
                    data: dailySanctioned
                }
            ],
            chart: {
                height: 350,
                type: 'line',
                background: 'transparent',
                toolbar: { show: false }
            },
            theme: { mode: themeMode },
            colors: ['#00e5ff', '#d500f9'],
            stroke: {
                width: [3, 3],
                curve: 'smooth',
                dashArray: [0, 5] // 1st is solid, 2nd is dashed
            },
            markers: {
                size: 4,
                strokeColors: ['#00e5ff', '#d500f9'],
                strokeWidth: 2,
                fillOpacity: 0,
                hover: { size: 6 }
            },
            xaxis: {
                categories: dailyDates,
                type: 'category',
                labels: {
                    style: { colors: '#8c9ba5' },
                    hideOverlappingLabels: true
                },
                tickAmount: 15
            },
            yaxis: {
                title: { text: '건수 (건)', style: { color: '#8c9ba5' } },
                labels: { style: { colors: '#8c9ba5' } }
            },
            tooltip: {
                shared: true,
                intersect: false
            },
            legend: {
                position: 'top',
                labels: { colors: '#f1f3f9' }
            },
            grid: {
                borderColor: 'rgba(255, 255, 255, 0.05)'
            }
        };
        
        updateOrCreateChart('chart-daily-trend', dailyTrendOptions);
    } catch (e) {
        console.error("Daily Trend rendering failed:", e);
    }
    
    // --- Chart 2: Top Reasons (Horizontal Bar Chart - Top 10) ---
    try {
        const rsnData = data.reason_stats.slice(0, 10); // Top 10 reasons
        const rsnNames = rsnData.map(r => r.reason);
        const rsnCounts = rsnData.map(r => r.count);
        
        const rsnOptions = {
            series: [{
                name: '제재 발생 수',
                data: rsnCounts
            }],
            chart: {
                type: 'bar',
                height: 350,
                background: 'transparent',
                toolbar: { show: false }
            },
            theme: { mode: themeMode },
            plotOptions: {
                bar: {
                    borderRadius: 4,
                    horizontal: true,
                    barHeight: '70%',
                    distributed: false // Single purple color
                }
            },
            colors: ['#9d4edd'],
            xaxis: {
                categories: rsnNames,
                labels: { style: { colors: '#8c9ba5' } }
            },
            yaxis: {
                labels: { style: { colors: '#f1f3f9' } }
            },
            legend: { show: false },
            grid: {
                borderColor: 'rgba(255, 255, 255, 0.05)'
            }
        };
        
        updateOrCreateChart('chart-top-reasons', rsnOptions);
    } catch (e) {
        console.error("Top Reasons rendering failed:", e);
    }
    
    // --- Rank Tables: Inspected Rank & Duration Rank ---
    // 1. Inspected Rank Table
    try {
        const inspectedRankBody = document.querySelector('#table-rank-inspected tbody');
        if (inspectedRankBody) {
            const sortedByVolume = [...data.manager_stats].sort((a, b) => b.inspected - a.inspected);
            inspectedRankBody.innerHTML = sortedByVolume.map((m, idx) => `
                <tr>
                    <td class="rank-num" style="padding-left: 8px;">${idx + 1}</td>
                    <td>${m.manager}</td>
                    <td class="rank-val-highlight" style="text-align: right; padding-right: 8px; font-weight: bold; color: var(--neon-blue);">${m.inspected.toLocaleString()}건</td>
                </tr>
            `).join('');
        }
    } catch (e) {
        console.error("Inspected Rank rendering failed:", e);
    }
    
    // 2. Duration Rank Table (Fastest)
    try {
        const durationRankBody = document.querySelector('#table-rank-duration tbody');
        if (durationRankBody) {
            const sortedByDuration = [...data.manager_stats]
                .filter(m => m.avg_duration_sec > 0)
                .sort((a, b) => a.avg_duration_sec - b.avg_duration_sec);
            durationRankBody.innerHTML = sortedByDuration.map((m, idx) => `
                <tr>
                    <td class="rank-num" style="padding-left: 8px;">${idx + 1}</td>
                    <td>${m.manager}</td>
                    <td class="rank-val-duration" style="text-align: right; padding-right: 8px; font-weight: bold; color: var(--neon-green);">${formatSecondsToMinSec(m.avg_duration_sec)}</td>
                </tr>
            `).join('');
        }
    } catch (e) {
        console.error("Duration Rank rendering failed:", e);
    }
    
    // --- Chart 3: Type 1 Share (Donut Chart) ---
    try {
        const type1Data = data.type1_stats;
        const type1Names = type1Data.map(t => t.type);
        const type1Counts = type1Data.map(t => t.count);
        
        const type1OverviewOptions = {
            series: type1Counts,
            chart: {
                height: 350,
                type: 'donut',
                background: 'transparent'
            },
            labels: type1Names,
            theme: { mode: themeMode },
            colors: ['#00f0ff', '#9d4edd', '#00e676', '#ff9100', '#3b82f6', '#ec4899', '#f59e0b', '#10b981', '#6366f1', '#a855f7'],
            stroke: { show: false },
            legend: {
                position: 'right',
                labels: { colors: '#f1f3f9' }
            },
            dataLabels: {
                enabled: false
            },
            plotOptions: {
                pie: {
                    donut: {
                        size: '65%',
                        labels: {
                            show: true,
                            total: {
                                show: true,
                                label: '총 검수량',
                                color: '#8c9ba5',
                                formatter: function (w) {
                                    return w.globals.seriesTotals.reduce((a, b) => a + b, 0).toLocaleString() + '건';
                                }
                            }
                        }
                    }
                }
            }
        };
        
        updateOrCreateChart('chart-type1-overview-share', type1OverviewOptions);
    } catch (e) {
        console.error("Type 1 Share rendering failed:", e);
    }
    
    // --- Chart 4: Managers Detail Compare (Grouped Bar Chart) ---
    const allMgrData = data.manager_stats;
    const allMgrNames = allMgrData.map(m => m.manager);
    const allMgrInspected = allMgrData.map(m => m.inspected);
    const allMgrRates = allMgrData.map(m => m.rate);
    
    const mgrCompareOptions = {
        series: [
            {
                name: '총 검수량',
                type: 'column',
                data: allMgrInspected
            },
            {
                name: '제재 성공률 (%)',
                type: 'line',
                data: allMgrRates
            }
        ],
        chart: {
            height: 350,
            type: 'line',
            background: 'transparent',
            toolbar: { show: false }
        },
        theme: { mode: themeMode },
        colors: ['#00f0ff', '#ff9100'],
        stroke: {
            width: [0, 3],
            curve: 'smooth'
        },
        xaxis: {
            categories: allMgrNames,
            labels: { style: { colors: '#8c9ba5' } }
        },
        yaxis: [
            {
                title: { text: '검수량 (건)', style: { color: '#8c9ba5' } },
                labels: { style: { colors: '#8c9ba5' } }
            },
            {
                opposite: true,
                title: { text: '제재 성공률 (%)', style: { color: '#ff9100' } },
                labels: { style: { colors: '#ff9100' } },
                max: 100
            }
        ],
        legend: {
            position: 'top',
            labels: { colors: '#f1f3f9' }
        },
        grid: {
            borderColor: 'rgba(255, 255, 255, 0.05)'
        }
    };
    
    updateOrCreateChart('chart-managers-bar', mgrCompareOptions);
    
    // --- Chart 5 & 6: Type1 & Type2 Distribution ---
    const type1Categories = data.type1_stats.map(t => t.type);
    const type1Counts = data.type1_stats.map(t => t.count);
    
    const type1Options = {
        series: [{ name: '요청 수', data: type1Counts }],
        chart: { type: 'bar', height: 300, background: 'transparent', toolbar: { show: false } },
        theme: { mode: themeMode },
        colors: ['#9d4edd'],
        plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
        xaxis: { categories: type1Categories, labels: { style: { colors: '#8c9ba5' }, rotate: -45 } },
        yaxis: { labels: { style: { colors: '#8c9ba5' } } },
        grid: { borderColor: 'rgba(255, 255, 255, 0.05)' }
    };
    updateOrCreateChart('chart-type1-distribution', type1Options);

    const type2Categories = data.type2_stats.map(t => t.type);
    const type2Counts = data.type2_stats.map(t => t.count);
    
    const type2Options = {
        series: [{ name: '요청 수', data: type2Counts }],
        chart: { type: 'bar', height: 300, background: 'transparent', toolbar: { show: false } },
        theme: { mode: themeMode },
        colors: ['#00e676'],
        plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
        xaxis: { categories: type2Categories, labels: { style: { colors: '#8c9ba5' }, rotate: -45 } },
        yaxis: { labels: { style: { colors: '#8c9ba5' } } },
        grid: { borderColor: 'rgba(255, 255, 255, 0.05)' }
    };
    updateOrCreateChart('chart-type2-distribution', type2Options);

    // --- Chart 7: Long-term Monthly Trend (Line & Area Chart) ---
    const monthlyData = data.monthly_trend;
    const monthlyMonths = monthlyData.map(m => {
        const parts = m.month.split('-');
        return `${parts[0]}년 ${parts[1]}월`;
    });
    const monthlyInspected = monthlyData.map(m => m.inspected);
    const monthlySanctioned = monthlyData.map(m => m.sanctioned);
    const monthlyRates = monthlyData.map(m => m.rate);
    const monthlyDurations = monthlyData.map(m => m.avg_duration);
    
    const monthlyTrendOptions = {
        series: [
            {
                name: '총 검수량',
                type: 'column',
                data: monthlyInspected
            },
            {
                name: '제재 성공률 (%)',
                type: 'line',
                data: monthlyRates
            }
        ],
        chart: {
            height: 350,
            type: 'line',
            background: 'transparent',
            toolbar: { show: false }
        },
        theme: { mode: themeMode },
        colors: ['#00f0ff', '#ff9100'],
        stroke: {
            width: [0, 3],
            curve: 'smooth'
        },
        xaxis: {
            categories: monthlyMonths,
            labels: { style: { colors: '#8c9ba5' } }
        },
        yaxis: [
            {
                title: { text: '검수량 (건)', style: { color: '#8c9ba5' } },
                labels: { style: { colors: '#8c9ba5' } }
            },
            {
                opposite: true,
                title: { text: '제재 성공률 (%)', style: { color: '#ff9100' } },
                labels: { style: { colors: '#ff9100' } },
                max: 100
            }
        ],
        legend: {
            position: 'top',
            labels: { colors: '#f1f3f9' }
        },
        grid: {
            borderColor: 'rgba(255, 255, 255, 0.05)'
        }
    };
    updateOrCreateChart('chart-monthly-trend', monthlyTrendOptions);
    
    // --- Chart 8: Monthly Stacked Sanctioned Amount ---
    const monthlyStackedOptions = {
        series: [{
            name: '제재 성공 건수',
            data: monthlySanctioned
        }],
        chart: {
            type: 'bar',
            height: 300,
            background: 'transparent',
            toolbar: { show: false }
        },
        theme: { mode: themeMode },
        colors: ['#9d4edd'],
        plotOptions: {
            bar: {
                borderRadius: 4,
                columnWidth: '50%'
            }
        },
        xaxis: {
            categories: monthlyMonths,
            labels: { style: { colors: '#8c9ba5' } }
        },
        yaxis: {
            labels: { style: { colors: '#8c9ba5' } }
        },
        grid: {
            borderColor: 'rgba(255, 255, 255, 0.05)'
        }
    };
    updateOrCreateChart('chart-monthly-stacked', monthlyStackedOptions);
    
    // --- Chart 9: Monthly Average Duration (Line Chart) ---
    const monthlyDurationOptions = {
        series: [{
            name: '평균 소요 시간 (초)',
            data: monthlyDurations
        }],
        chart: {
            type: 'line',
            height: 300,
            background: 'transparent',
            toolbar: { show: false }
        },
        theme: { mode: themeMode },
        colors: ['#00e676'],
        stroke: {
            width: 3,
            curve: 'smooth'
        },
        markers: {
            size: 4
        },
        xaxis: {
            categories: monthlyMonths,
            labels: { style: { colors: '#8c9ba5' } }
        },
        yaxis: {
            labels: { style: { colors: '#8c9ba5' } }
        },
        grid: {
            borderColor: 'rgba(255, 255, 255, 0.05)'
        }
    };
    updateOrCreateChart('chart-monthly-duration', monthlyDurationOptions);
}

// Helper to destroy and rebuild charts dynamically
function updateOrCreateChart(elementId, options) {
    if (charts[elementId]) {
        charts[elementId].destroy();
    }
    
    const element = document.getElementById(elementId);
    if (element) {
        charts[elementId] = new ApexCharts(element, options);
        charts[elementId].render();
    }
}

// 7. Render Data Tables
function renderTables(data) {
    // A. Manager Table
    const tbodyManagers = document.querySelector('#table-managers tbody');
    if (tbodyManagers) {
        tbodyManagers.innerHTML = '';
        data.manager_stats.forEach(m => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td style="font-weight: 600;">${m.manager}</td>
                <td>${m.inspected.toLocaleString()}건</td>
                <td>${m.sanctioned.toLocaleString()}건</td>
                <td style="font-weight: 600; color: ${m.rate > 40 ? 'var(--neon-blue)' : 'var(--text-primary)'}">${m.rate.toFixed(2)}%</td>
                <td>${m.avg_duration_str}</td>
            `;
            tbodyManagers.appendChild(row);
        });
    }
    
    // B. Reasons Table
    const tbodyReasons = document.querySelector('#table-reasons tbody');
    if (tbodyReasons) {
        tbodyReasons.innerHTML = '';
        data.reason_stats.forEach((r, idx) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td style="font-weight: 600; color: var(--neon-blue);">${idx + 1}</td>
                <td>${r.reason}</td>
                <td style="font-weight: 600;">${r.count.toLocaleString()}건</td>
                <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="width: 50px;">${r.percentage}%</span>
                        <div style="flex-grow: 1; height: 6px; background-color: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; max-width: 150px;">
                            <div style="width: ${r.percentage}%; height: 100%; background: linear-gradient(to right, var(--neon-blue), var(--neon-purple));"></div>
                        </div>
                    </div>
                </td>
            `;
            tbodyReasons.appendChild(row);
        });
    }
    
    // C. Recent Records Table
    renderRecentRecordsTable();

    // D. Monthly Summary Table (User Overhauled UI)
    renderMonthlySummaryTable(data.monthly_trend);
}

// 7.1. Render Monthly KPI Summary Table with Comparison
function renderMonthlySummaryTable(monthlyTrend) {
    const tbody = document.querySelector('#table-monthly-summary tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    // Sort trend chronologically (ascending) for proper comparison
    const sortedTrend = [...monthlyTrend].sort((a, b) => a.month.localeCompare(b.month));
    
    sortedTrend.forEach((current, i) => {
        const previous = i > 0 ? sortedTrend[i-1] : null;
        const row = document.createElement('tr');
        
        // Month label format (e.g. 2026-01 -> 1월)
        const parts = current.month.split('-');
        const monthNum = parseInt(parts[1]);
        const monthName = `${monthNum}월`;
        
        // Inspected Column
        let inspectedHtml = `<td style="font-weight: 600; color: #fff;">${current.inspected.toLocaleString()} 건`;
        if (previous) {
            const diff = current.inspected - previous.inspected;
            const pct = previous.inspected > 0 ? ((diff / previous.inspected) * 100).toFixed(1) : 0;
            if (diff > 0) {
                inspectedHtml += `<span class="trend-up">▲ ${diff.toLocaleString()}건 (+${pct}%)</span>`;
            } else if (diff < 0) {
                inspectedHtml += `<span class="trend-down">▼ ${Math.abs(diff).toLocaleString()}건 (-${Math.abs(pct)}%)</span>`;
            } else {
                inspectedHtml += `<span class="trend-neutral">-</span>`;
            }
        } else {
            inspectedHtml += `<span class="trend-neutral">-</span>`;
        }
        inspectedHtml += `</td>`;
        
        // Sanctioned Column
        let sanctionedHtml = `<td style="font-weight: 600; color: #c5a3ff;">${current.sanctioned.toLocaleString()} 건`;
        if (previous) {
            const diff = current.sanctioned - previous.sanctioned;
            const pct = previous.sanctioned > 0 ? ((diff / previous.sanctioned) * 100).toFixed(1) : 0;
            if (diff > 0) {
                sanctionedHtml += `<span class="trend-up">▲ ${diff.toLocaleString()}건 (+${pct}%)</span>`;
            } else if (diff < 0) {
                sanctionedHtml += `<span class="trend-down">▼ ${Math.abs(diff).toLocaleString()}건 (-${Math.abs(pct)}%)</span>`;
            } else {
                sanctionedHtml += `<span class="trend-neutral">-</span>`;
            }
        } else {
            sanctionedHtml += `<span class="trend-neutral">-</span>`;
        }
        sanctionedHtml += `</td>`;
        
        // Sanction Rate Column
        let rateHtml = `<td style="font-weight: 600; color: #ff5252;">${current.rate.toFixed(1)}%`;
        if (previous) {
            const diff = (current.rate - previous.rate).toFixed(1);
            if (diff > 0) {
                rateHtml += `<span class="trend-up">▲ +${diff}%p</span>`;
            } else if (diff < 0) {
                rateHtml += `<span class="trend-down">▼ -${Math.abs(diff).toFixed(1)}%p</span>`;
            } else {
                rateHtml += `<span class="trend-neutral">-</span>`;
            }
        } else {
            rateHtml += `<span class="trend-neutral">-</span>`;
        }
        rateHtml += `</td>`;
        
        // Avg Duration Column
        const durationFormatted = formatSecondsToMinSec(current.avg_duration);
        let durationHtml = `<td style="font-weight: 600; color: #00e676;">${durationFormatted}`;
        if (previous) {
            const diff = Math.round(current.avg_duration - previous.avg_duration);
            if (diff > 0) {
                durationHtml += `<span class="trend-up">▲ +${diff}초 지연</span>`;
            } else if (diff < 0) {
                durationHtml += `<span class="trend-down">▼ ${Math.abs(diff)}초 단축</span>`;
            } else {
                durationHtml += `<span class="trend-neutral">-</span>`;
            }
        } else {
            durationHtml += `<span class="trend-neutral">-</span>`;
        }
        durationHtml += `</td>`;
        
        row.innerHTML = `
            <td style="font-weight: 700; color: var(--neon-blue);">${monthName}</td>
            ${inspectedHtml}
            ${sanctionedHtml}
            ${rateHtml}
            ${durationHtml}
        `;
        tbody.appendChild(row);
    });
}

// 8. Render and filter recent records table
function renderRecentRecordsTable() {
    if (!dashboardData) return;
    
    const tbodyRecords = document.querySelector('#table-recent-records tbody');
    if (!tbodyRecords) return;
    
    const query = document.getElementById('table-search').value.toLowerCase().trim();
    const filterTerm = document.getElementById('filter-term').value;
    const filterMgr = document.getElementById('filter-manager').value;
    
    tbodyRecords.innerHTML = '';
    
    // Filter records list
    const filteredRecords = dashboardData.recent_records.filter(rec => {
        // Query search (name, manager, reason, type1, type2)
        const matchesQuery = !query || 
            rec.name.toLowerCase().includes(query) || 
            rec.manager.toLowerCase().includes(query) || 
            rec.reason.toLowerCase().includes(query) ||
            rec.type1.toLowerCase().includes(query) ||
            rec.type2.toLowerCase().includes(query);
            
        // Term filter
        let matchesTerm = true;
        if (filterTerm === 'Y') {
            matchesTerm = rec.term.trim().toUpperCase() === 'Y';
        } else if (filterTerm === 'empty') {
            matchesTerm = rec.term.trim() === '' || rec.term.toLowerCase() === 'nan';
        }
        
        // Manager filter
        const matchesMgr = !filterMgr || rec.manager === filterMgr;
        
        return matchesQuery && matchesTerm && matchesMgr;
    });
    
    if (filteredRecords.length === 0) {
        tbodyRecords.innerHTML = `
            <tr>
                <td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 40px 0;">
                    <i class="fa-solid fa-folder-open" style="font-size: 24px; margin-bottom: 10px; display: block;"></i>
                    조건에 일치하는 검수 내역이 없습니다.
                </td>
            </tr>
        `;
        return;
    }
    
    filteredRecords.forEach(rec => {
        const isSanctioned = rec.term.trim().toUpperCase() === 'Y';
        const badgeClass = isSanctioned ? 'sanctioned' : 'pending';
        const badgeText = isSanctioned ? '제재 완료' : '미제재';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="font-size: 13px; color: var(--text-secondary);">${rec.end}</td>
            <td style="font-weight: 500;">${rec.manager}</td>
            <td>${rec.name}</td>
            <td><span class="status-badge ${badgeClass}">${badgeText}</span></td>
            <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${rec.reason}">
                ${rec.reason}
            </td>
            <td><span class="badge">${rec.type1}</span></td>
            <td><span class="badge" style="border-color: rgba(0, 230, 118, 0.2); color: var(--neon-green);">${rec.type2}</span></td>
            <td>${rec.duration}</td>
        `;
        tbodyRecords.appendChild(row);
    });
}

// 9. Attach filtering events
function initTableFilters() {
    const searchInput = document.getElementById('table-search');
    const termSelect = document.getElementById('filter-term');
    const mgrSelect = document.getElementById('filter-manager');
    
    if (searchInput) searchInput.addEventListener('input', renderRecentRecordsTable);
    if (termSelect) termSelect.addEventListener('change', renderRecentRecordsTable);
    if (mgrSelect) mgrSelect.addEventListener('change', renderRecentRecordsTable);
}

// 10. Floating Toast Message Helper
function showToast(message, iconClass = 'fa-circle-info', color = 'var(--neon-blue)') {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-msg');
    const toastIcon = document.getElementById('toast-icon');
    
    if (!toast) return;
    
    toastMsg.textContent = message;
    toastIcon.className = `fa-solid ${iconClass}`;
    toastIcon.style.color = color;
    toast.style.borderLeftColor = color;
    
    toast.classList.add('show');
    
    // Hide toast after 4 seconds
    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}
