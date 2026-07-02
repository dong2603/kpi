import os
import re
import urllib.request
import ssl
import gc
import pandas as pd
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# Local data cache path
DATA_DIR = os.path.dirname(os.path.abspath(__file__))
LOCAL_CSV = os.path.join(DATA_DIR, "google_sheets_data.csv")
DEFAULT_SHEET_ID = "1Qvg1C1yKhOnz3TdpGT1MBjFnr9Ma3t98z3T6V8mu_Ag"
DEFAULT_GID = "1028730445"

def extract_sheet_id_and_gid(url_or_id):
    sheet_id = DEFAULT_SHEET_ID
    gid = DEFAULT_GID
    
    if not url_or_id:
        return sheet_id, gid
        
    id_match = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", url_or_id)
    if id_match:
        sheet_id = id_match.group(1)
    else:
        sheet_id = url_or_id
        
    gid_match = re.search(r"[?&]gid=([0-9]+)", url_or_id)
    if gid_match:
        gid = gid_match.group(1)
        
    return sheet_id, gid

def download_sheet_csv(sheet_id, gid):
    export_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"
    temp_path = os.path.join(DATA_DIR, f"temp_{sheet_id}.csv")
    
    print(f"Downloading CSV from: {export_url}")
    # User-Agent header to avoid Google blockage
    req = urllib.request.Request(
        export_url, 
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    )
    
    # Avoid SSL certificate verify failed error on Render/Linux
    context = ssl._create_unverified_context()
    with urllib.request.urlopen(req, context=context) as response, open(temp_path, 'wb') as out_file:
        out_file.write(response.read())
    
    # Overwrite the cache file if it downloaded successfully
    if os.path.exists(LOCAL_CSV):
        try:
            os.remove(LOCAL_CSV)
        except Exception:
            pass
    try:
        os.replace(temp_path, LOCAL_CSV)
    except Exception:
        import shutil
        shutil.move(temp_path, LOCAL_CSV)
    print("CSV Download completed successfully.")

def find_header_row_csv(filepath):
    header_row_idx = 7 # Default fallback
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            for r_idx in range(20):
                line = f.readline()
                if not line:
                    break
                row_vals = [x.strip().lower() for x in line.split(',')]
                if 'start' in row_vals and 'end' in row_vals and 'manager' in row_vals:
                    header_row_idx = r_idx
                    break
    except Exception as e:
        print(f"Failed to find CSV header row: {e}")
    return header_row_idx

def parse_time_to_seconds(t_val):
    if pd.isna(t_val):
        return 0
    # Try parsing string format (e.g. 0:12:32 or 12:32)
    t_str = str(t_val).strip()
    try:
        parts = t_str.split(':')
        if len(parts) == 3:
            h, m, s = parts
            # float conversion to handle milliseconds like 0:15:12.500
            return int(h) * 3600 + int(m) * 60 + float(s)
        elif len(parts) == 2:
            m, s = parts
            return int(m) * 60 + float(s)
    except Exception:
        pass
    return 0

def format_seconds_to_str(total_seconds):
    if not total_seconds or total_seconds <= 0:
        return "00:00"
    h = int(total_seconds // 3600)
    m = int((total_seconds % 3600) // 60)
    s = int(total_seconds % 60)
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"

@app.route('/api/log', methods=['POST'])
def client_log():
    try:
        data = request.get_json()
        print(f"\n[CLIENT ERROR LOG] {data.get('message')}\nAt {data.get('source')}:{data.get('line')}:{data.get('col')}\nStack: {data.get('stack')}\n")
    except Exception as e:
        print(f"Logging error: {e}")
    return jsonify({"success": True})

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def send_static(path):
    return send_from_directory('.', path)

# Global cache in-memory
cached_df = None
cached_sheets_list = []
cached_download_error = None

def load_cached_data(sheet_id, gid, force=False):
    global cached_df, cached_sheets_list, cached_download_error
    
    print(f"[CACHE DEBUG] force={force}, cached_df is None={cached_df is None}, file_exists={os.path.exists(LOCAL_CSV)}")
    if force or cached_df is None or not os.path.exists(LOCAL_CSV):
        print("[CACHE DEBUG] Cache MISS! Re-reading CSV file...")
        # 1. Download sheet if force=True or LOCAL_CSV doesn't exist
        if force or not os.path.exists(LOCAL_CSV):
            try:
                download_sheet_csv(sheet_id, gid)
                cached_download_error = None
            except Exception as e:
                cached_download_error = str(e)
                print(f"CSV Download failed: {e}. Using cached local data if available.")
                if not os.path.exists(LOCAL_CSV):
                    raise e
                    
        # 2. Parse CSV file header row index
        header_row_idx = find_header_row_csv(LOCAL_CSV)
        
        # 3. Parse only required columns from CSV (Extremely Low Memory)
        cols_to_use = [
            'end', 'manager', 'platformf', 'term', 'name', 
            'steamid', 'detail reason', 'type1', 'type2', '완료소요시간'
        ]
        
        df = pd.read_csv(
            LOCAL_CSV, 
            skiprows=header_row_idx,
            usecols=cols_to_use,
            encoding='utf-8',
            on_bad_lines='skip'
        )
        
        # Clean column names (strip spaces)
        df.columns = [str(col).strip() for col in df.columns]
        
        # Drop rows where 'end' is empty
        df = df.dropna(subset=['end'])
        
        # Convert 'end' to datetime
        df['end_dt'] = pd.to_datetime(df['end'], errors='coerce')
        df = df.dropna(subset=['end_dt'])
        
        # Sort by end datetime descending
        df = df.sort_values(by='end_dt', ascending=False)
        
        # Parse duration seconds for later aggregations
        df['duration_sec'] = df['완료소요시간'].apply(parse_time_to_seconds)
        df['term_clean'] = df['term'].astype(str).str.strip().str.upper()
        df['year_month_str'] = df['end_dt'].dt.strftime('%Y-%m')
        
        # Save to memory cache
        cached_df = df
        
        # CSV mode fallback for sheet names (static)
        cached_sheets_list = ["PUBG Court"]
        
        # Force garbage collection to free memory instantly
        gc.collect()
            
    return cached_df, cached_sheets_list, cached_download_error

@app.route('/api/court-data')
def get_court_data():
    sheet_param = request.args.get('url', '')
    sheet_id, gid = extract_sheet_id_and_gid(sheet_param)
    force_download = request.args.get('force', 'false').lower() == 'true'
    
    # Query filters
    manager = request.args.get('manager', '')
    platform = request.args.get('platform', '')
    sanction_type = request.args.get('sanction_type', '')
    year_month = request.args.get('year_month', '')
    day = request.args.get('day', '')
    
    try:
        # Load from cache (or re-load if force_download is True)
        df, active_sheets, download_error = load_cached_data(sheet_id, gid, force=force_download)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": f"데이터 로드 실패: {str(e)}"
        }), 500

    try:
        # Format year-month string for long-term and filtering
        available_months = sorted(list(df['year_month_str'].dropna().unique()), reverse=True)
        available_managers = sorted(list(df['manager'].dropna().astype(str).str.strip().unique()))
        available_platforms = sorted(list(df['platformf'].dropna().astype(str).str.strip().unique()))
        available_sanctions = sorted(list(df['term'].dropna().astype(str).str.strip().unique()))
        
        # A. Apply entity-level filters (manager, platform, sanction_type)
        #    These apply to both the monthly summary table AND detailed views.
        df_entity_filtered = df.copy()
        
        if manager:
            df_entity_filtered = df_entity_filtered[df_entity_filtered['manager'].astype(str).str.strip() == manager]
        if platform:
            df_entity_filtered = df_entity_filtered[df_entity_filtered['platformf'].astype(str).str.strip() == platform]
        if sanction_type:
            df_entity_filtered = df_entity_filtered[df_entity_filtered['term'].astype(str).str.strip() == sanction_type]
        
        # B. Long-term Monthly Trend (entity-filtered, but NOT month/day-filtered)
        monthly_group = df_entity_filtered.groupby('year_month_str')
        monthly_trend = []
        for m_str, group in sorted(monthly_group):
            m_inspected = len(group)
            m_sanctions = len(group[group['term_clean'].isin(['Y', '30DAYS', '1DAY', '3DAYS', '7DAYS', '15DAYS'])])
            m_rate = round((m_sanctions / m_inspected * 100), 2) if m_inspected > 0 else 0
            m_dur_df = group[group['duration_sec'] > 0]
            m_avg_dur = round(m_dur_df['duration_sec'].mean(), 1) if len(m_dur_df) > 0 else 0
            
            monthly_trend.append({
                "month": m_str,
                "inspected": m_inspected,
                "sanctioned": m_sanctions,
                "rate": m_rate,
                "avg_duration": m_avg_dur
            })

        # C. Apply time-level filters (year_month, day) for detailed views
        df_filtered = df_entity_filtered.copy()
        
        if year_month:
            df_filtered = df_filtered[df_filtered['year_month_str'] == year_month]
        if day:
            df_filtered = df_filtered[df_filtered['end_dt'].dt.day == int(day)]
            
        # Get actual available days for this selection
        available_days = [int(x) for x in sorted(list(df_filtered['end_dt'].dt.day.unique()))]
            
        # 1. Total Metrics (Filtered)
        total_inspected = len(df_filtered)
        sanctioned_df = df_filtered[df_filtered['term_clean'].isin(['Y', '30DAYS', '1DAY', '3DAYS', '7DAYS', '15DAYS'])]
        total_sanctions = len(sanctioned_df)
        sanction_rate = round((total_sanctions / total_inspected * 100), 2) if total_inspected > 0 else 0
        
        valid_duration_df = df_filtered[df_filtered['duration_sec'] > 0]
        avg_duration_sec = valid_duration_df['duration_sec'].mean() if len(valid_duration_df) > 0 else 0
        avg_duration_str = format_seconds_to_str(avg_duration_sec)
        
        # 2. Daily Trend (Group by end date: PUBG day starts at 07:00:00)
        df_filtered['pubg_date'] = (df_filtered['end_dt'] - pd.Timedelta(hours=7)).dt.date
        daily_group = df_filtered.groupby('pubg_date')
        daily_trend = []
        for date, group in sorted(daily_group):
            g_inspected = len(group)
            g_sanctions = len(group[group['term_clean'].isin(['Y', '30DAYS', '1DAY', '3DAYS', '7DAYS', '15DAYS'])])
            g_rate = round((g_sanctions / g_inspected * 100), 2) if g_inspected > 0 else 0
            g_dur_df = group[group['duration_sec'] > 0]
            g_avg_dur = round(g_dur_df['duration_sec'].mean(), 1) if len(g_dur_df) > 0 else 0
            
            daily_trend.append({
                "date": date.strftime("%Y-%m-%d"),
                "inspected": g_inspected,
                "sanctioned": g_sanctions,
                "rate": g_rate,
                "avg_duration": g_avg_dur
            })
            
        # 3. Manager Performance (Filtered)
        manager_group = df_filtered.groupby('manager')
        manager_stats = []
        for mgr, group in manager_group:
            if pd.isna(mgr) or str(mgr).strip() == "":
                continue
            m_inspected = len(group)
            m_sanctions = len(group[group['term_clean'].isin(['Y', '30DAYS', '1DAY', '3DAYS', '7DAYS', '15DAYS'])])
            m_rate = round((m_sanctions / m_inspected * 100), 2) if m_inspected > 0 else 0
            m_dur_df = group[group['duration_sec'] > 0]
            m_avg_dur = m_dur_df['duration_sec'].mean() if len(m_dur_df) > 0 else 0
            
            manager_stats.append({
                "manager": str(mgr).strip(),
                "inspected": m_inspected,
                "sanctioned": m_sanctions,
                "rate": m_rate,
                "avg_duration_sec": round(m_avg_dur, 1),
                "avg_duration_str": format_seconds_to_str(m_avg_dur)
            })
        manager_stats = sorted(manager_stats, key=lambda x: x['inspected'], reverse=True)
            
        # 4. Reason Distribution (Filtered)
        reason_group = df_filtered.groupby('detail reason')
        reason_stats = []
        for rsn, group in reason_group:
            if pd.isna(rsn) or str(rsn).strip() == "" or str(rsn).strip() == "nan":
                continue
            r_count = len(group)
            reason_stats.append({
                "reason": str(rsn).strip(),
                "count": r_count,
                "percentage": round((r_count / total_inspected * 100), 1) if total_inspected > 0 else 0
            })
        reason_stats = sorted(reason_stats, key=lambda x: x['count'], reverse=True)[:15]
        
        # 5. Type1 & Type2 Distribution (Filtered)
        type1_stats = []
        type1_group = df_filtered.groupby('type1')
        for t1, group in type1_group:
            if pd.isna(t1) or str(t1).strip() == "" or str(t1).strip() == "nan":
                continue
            type1_stats.append({"type": str(t1).strip(), "count": len(group)})
        type1_stats = sorted(type1_stats, key=lambda x: x['count'], reverse=True)[:10]

        type2_stats = []
        type2_group = df_filtered.groupby('type2')
        for t2, group in type2_group:
            if pd.isna(t2) or str(t2).strip() == "" or str(t2).strip() == "nan":
                continue
            type2_stats.append({"type": str(t2).strip(), "count": len(group)})
        type2_stats = sorted(type2_stats, key=lambda x: x['count'], reverse=True)[:10]

        # 6. Recent Records (Top 50 - Filtered)
        recent_records = []
        df_recent = df_filtered.head(50)
        for _, row in df_recent.iterrows():
            recent_records.append({
                "end": str(row['end']),
                "manager": str(row['manager']) if pd.notna(row['manager']) else "",
                "term": str(row['term']) if pd.notna(row['term']) else "",
                "name": str(row['name']) if pd.notna(row['name']) else "",
                "steamid": str(row['steamid']) if pd.notna(row['steamid']) else "",
                "reason": str(row['detail reason']) if pd.notna(row['detail reason']) else "",
                "type1": str(row['type1']) if pd.notna(row['type1']) else "",
                "type2": str(row['type2']) if pd.notna(row['type2']) else "",
                "duration": str(row['완료소요시간']) if pd.notna(row['완료소요시간']) else ""
            })
            
        # Get active sheets summary information
        active_sheets = ["PUBG Court"]

        response_data = {
            "success": True,
            "sheet_id": sheet_id,
            "sheets_list": active_sheets,
            "available_months": available_months,
            "available_managers": available_managers,
            "available_platforms": available_platforms,
            "available_sanctions": available_sanctions,
            "available_days": available_days,
            "monthly_trend": monthly_trend,
            "selected_month": year_month,
            "selected_manager": manager,
            "selected_platform": platform,
            "selected_sanction": sanction_type,
            "selected_day": day,
            "summary": {
                "total_inspected": total_inspected,
                "total_sanctions": total_sanctions,
                "sanction_rate": sanction_rate,
                "avg_duration_sec": round(avg_duration_sec, 1),
                "avg_duration_str": avg_duration_str,
                "download_error": download_error
            },
            "daily_trend": daily_trend,
            "manager_stats": manager_stats,
            "reason_stats": reason_stats,
            "type1_stats": type1_stats,
            "type2_stats": type2_stats,
            "recent_records": recent_records
        }
        return jsonify(response_data)
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": f"데이터 처리 중 에러 발생: {str(e)}"
        }), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"Starting Flask server on port {port}...")
    app.run(host='0.0.0.0', port=port, debug=False)
