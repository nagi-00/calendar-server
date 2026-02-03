import express from 'express';
import cors from 'cors';
import { Client } from '@notionhq/client';
 
const app = express();
app.use(cors());
app.use(express.json());
 
// 헬퍼: 데이터베이스에서 제목 속성 이름 찾기
async function getTitlePropertyName(notion, dbId) {
    const database = await notion.databases.retrieve({ database_id: dbId });
    for (const [name, prop] of Object.entries(database.properties)) {
        if (prop.type === 'title') {
            return name;
        }
    }
    return 'Name'; // 기본값
}
 
// 헬퍼: 페이지에서 제목 가져오기
function getPageTitle(page) {
    for (const [name, prop] of Object.entries(page.properties)) {
        if (prop.type === 'title' && prop.title?.length > 0) {
            return prop.title[0].plain_text;
        }
    }
    return '제목 없음';
}
 
// 헬퍼: 반복 요일 파싱 (multi_select에서 숫자 배열로)
function parseRepeatDays(repeatDaysProp) {
    if (!repeatDaysProp?.multi_select) return null;
    const days = repeatDaysProp.multi_select.map(opt => {
        const dayMap = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };
        return dayMap[opt.name] ?? parseInt(opt.name);
    }).filter(d => !isNaN(d));
    return days.length > 0 ? days : null;
}
 
// 헬퍼: 반복 요일을 multi_select 형식으로 변환
function formatRepeatDays(repeatDays) {
    if (!repeatDays || !Array.isArray(repeatDays) || repeatDays.length === 0) return null;
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    return repeatDays.map(d => ({ name: dayNames[d] || String(d) }));
}
 
// 1. 노션 데이터베이스 목록 조회 (온보딩 시 사용)
app.post('/api/notion/databases', async (req, res) => {
    try {
        const notion = new Client({ auth: req.body.token });
        const response = await notion.search({
            filter: { value: 'database', property: 'object' }
        });
        res.json(response.results.map(db => ({
            id: db.id,
            title: db.title[0]?.plain_text || 'Untitled'
        })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
 
// 2. 캘린더 일정 조회 (위젯 렌더링 시 사용)
app.post('/api/notion/events', async (req, res) => {
    const { token, dbId } = req.body;
    const notion = new Client({ auth: token });
    try {
        const response = await notion.databases.query({
            database_id: dbId,
            sorts: [{ property: 'Date', direction: 'ascending' }],
        });
 
        const today = new Date();
        const todayDay = today.getDay(); // 0=일, 1=월, ...
 
        const events = [];
 
        for (const page of response.results) {
            const props = page.properties;
            const dateProp = props.Date?.date;
 
            // 날짜/시간 파싱
            const startStr = dateProp?.start || '';
            const endStr = dateProp?.end || '';
 
            let date = startStr.split('T')[0];
            let startTime = null;
            let endTime = null;
 
            if (startStr.includes('T')) {
                startTime = startStr.split('T')[1]?.substring(0, 5);
            }
            if (endStr.includes('T')) {
                endTime = endStr.split('T')[1]?.substring(0, 5);
            }
 
            // 루틴 정보
            const isRoutine = props.Routine?.checkbox || false;
            const repeatDays = parseRepeatDays(props.RepeatDays);
 
            // 루틴인 경우, 오늘 요일에 해당하면 오늘 날짜로 표시
            let displayDate = date;
            if (isRoutine && repeatDays && repeatDays.includes(todayDay)) {
                displayDate = today.toISOString().split('T')[0];
            }
 
            events.push({
                id: page.id,
                title: getPageTitle(page),
                date: displayDate,
                originalDate: date,
                startTime: startTime,
                endTime: endTime,
                done: props.Done?.checkbox || false,
                priority: props.Priority?.checkbox || false,
                category: props.Category?.multi_select?.[0]?.name || null,
                isRoutine: isRoutine,
                repeatDays: repeatDays,
                url: page.url
            });
        }
 
        res.json(events);
    } catch (e) {
        res.status(500).json({ error: "일정을 불러오지 못했습니다: " + e.message });
    }
});
 
// 3. 새로운 일정 추가 (위젯에서 직접 입력 시 사용)
app.post('/api/notion/add-event', async (req, res) => {
    const { token, dbId, title, date, startTime, endTime, category, isRoutine, repeatDays } = req.body;
    const notion = new Client({ auth: token });
    try {
        // 제목 속성 이름 동적으로 찾기
        const titlePropName = await getTitlePropertyName(notion, dbId);
 
        // 날짜/시간 구성
        const startDateTime = startTime ? `${date}T${startTime}:00` : date;
        const endDateTime = endTime ? `${date}T${endTime}:00` : null;
 
        const dateProperty = { start: startDateTime };
        if (endDateTime) {
            dateProperty.end = endDateTime;
        }
 
        const properties = {
            [titlePropName]: { title: [{ text: { content: title } }] },
            "Date": { date: dateProperty }
        };
 
        // 카테고리가 있으면 추가
        if (category) {
            properties["Category"] = { multi_select: [{ name: category }] };
        }
 
        // 루틴 설정
        if (isRoutine) {
            properties["Routine"] = { checkbox: true };
 
            // 반복 요일 설정
            if (repeatDays && Array.isArray(repeatDays) && repeatDays.length > 0) {
                const formattedDays = formatRepeatDays(repeatDays);
                if (formattedDays) {
                    properties["RepeatDays"] = { multi_select: formattedDays };
                }
            }
        }
 
        await notion.pages.create({
            parent: { database_id: dbId },
            properties
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "일정 추가 실패: " + e.message });
    }
});
 
// 4. 카테고리 목록 조회
app.post('/api/notion/categories', async (req, res) => {
    const { token, dbId } = req.body;
    const notion = new Client({ auth: token });
    try {
        const database = await notion.databases.retrieve({ database_id: dbId });
        const categoryProp = database.properties.Category;
 
        // multi_select 또는 select 타입 지원
        let categories = [];
        if (categoryProp?.multi_select?.options) {
            categories = categoryProp.multi_select.options.map(opt => opt.name);
        } else if (categoryProp?.select?.options) {
            categories = categoryProp.select.options.map(opt => opt.name);
        }
 
        res.json({ categories });
    } catch (e) {
        res.status(500).json({ error: "카테고리 조회 실패: " + e.message });
    }
});
 
// 4-1. 카테고리 이름 변경
app.post('/api/notion/rename-category', async (req, res) => {
    const { token, dbId, oldName, newName } = req.body;
    const notion = new Client({ auth: token });
    try {
        const database = await notion.databases.retrieve({ database_id: dbId });
        const categoryProp = database.properties.Category;

        let options = [];
        if (categoryProp?.multi_select?.options) {
            options = categoryProp.multi_select.options.map(opt =>
                opt.name === oldName ? { ...opt, name: newName } : opt
            );
        }

        await notion.databases.update({
            database_id: dbId,
            properties: {
                "Category": { multi_select: { options } }
            }
        });

        const response = await notion.databases.query({
            database_id: dbId,
            filter: { property: "Category", multi_select: { contains: oldName } }
        });

        for (const page of response.results) {
            const currentCategories = page.properties.Category?.multi_select || [];
            const updatedCategories = currentCategories.map(cat =>
                cat.name === oldName ? { name: newName } : { name: cat.name }
            );
            await notion.pages.update({
                page_id: page.id,
                properties: { "Category": { multi_select: updatedCategories } }
            });
        }

        res.json({ success: true, updated: response.results.length });
    } catch (e) {
        res.status(500).json({ error: "카테고리 이름 변경 실패: " + e.message });
    }
});

// 4-2. 카테고리 삭제
app.post('/api/notion/delete-category', async (req, res) => {
    const { token, dbId, categoryName } = req.body;
    const notion = new Client({ auth: token });
    try {
        const database = await notion.databases.retrieve({ database_id: dbId });
        const categoryProp = database.properties.Category;

        let options = [];
        if (categoryProp?.multi_select?.options) {
            options = categoryProp.multi_select.options.filter(opt => opt.name !== categoryName);
        }

        await notion.databases.update({
            database_id: dbId,
            properties: { "Category": { multi_select: { options } } }
        });

        const response = await notion.databases.query({
            database_id: dbId,
            filter: { property: "Category", multi_select: { contains: categoryName } }
        });

        for (const page of response.results) {
            const currentCategories = page.properties.Category?.multi_select || [];
            const updatedCategories = currentCategories
                .filter(cat => cat.name !== categoryName)
                .map(cat => ({ name: cat.name }));
            await notion.pages.update({
                page_id: page.id,
                properties: { "Category": { multi_select: updatedCategories } }
            });
        }

        res.json({ success: true, updated: response.results.length });
    } catch (e) {
        res.status(500).json({ error: "카테고리 삭제 실패: " + e.message });
    }
});

// 5. 일정 수정
app.post('/api/notion/update-event', async (req, res) => {
    const { token, dbId, taskId, title, date, startTime, endTime, category, isRoutine, repeatDays } = req.body;
    const notion = new Client({ auth: token });
    try {
        const properties = {};
 
        if (title) {
            // 제목 속성 이름 동적으로 찾기
            const titlePropName = await getTitlePropertyName(notion, dbId);
            properties[titlePropName] = { title: [{ text: { content: title } }] };
        }
        if (date) {
            // 날짜/시간 구성
            const startDateTime = startTime ? `${date}T${startTime}:00` : date;
            const endDateTime = endTime ? `${date}T${endTime}:00` : null;
 
            const dateProperty = { start: startDateTime };
            if (endDateTime) {
                dateProperty.end = endDateTime;
            }
            properties["Date"] = { date: dateProperty };
        }
        if (category) {
            properties["Category"] = { multi_select: [{ name: category }] };
        }
 
        // 루틴 설정
        if (isRoutine !== undefined) {
            properties["Routine"] = { checkbox: !!isRoutine };
        }
 
        // 반복 요일 설정
        if (repeatDays !== undefined) {
            if (repeatDays && Array.isArray(repeatDays) && repeatDays.length > 0) {
                const formattedDays = formatRepeatDays(repeatDays);
                if (formattedDays) {
                    properties["RepeatDays"] = { multi_select: formattedDays };
                }
            } else {
                // 빈 배열이면 반복 요일 제거
                properties["RepeatDays"] = { multi_select: [] };
            }
        }
 
        await notion.pages.update({
            page_id: taskId,
            properties
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "일정 수정 실패: " + e.message });
    }
});
 
// 6. 일정 삭제 (아카이브 처리)
app.post('/api/notion/delete-event', async (req, res) => {
    const { token, taskId } = req.body;
    const notion = new Client({ auth: token });
    try {
        await notion.pages.update({
            page_id: taskId,
            archived: true
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "일정 삭제 실패: " + e.message });
    }
});
 
// 7. 중요 표시 토글 (Priority)
app.post('/api/notion/toggle-star', async (req, res) => {
    const { token, taskId } = req.body;
    const notion = new Client({ auth: token });
    try {
        // 현재 상태 조회
        const page = await notion.pages.retrieve({ page_id: taskId });
        const currentPriority = page.properties.Priority?.checkbox || false;
 
        // 토글
        await notion.pages.update({
            page_id: taskId,
            properties: {
                "Priority": { checkbox: !currentPriority }
            }
        });
        res.json({ success: true, priority: !currentPriority });
    } catch (e) {
        res.status(500).json({ error: "중요 표시 변경 실패: " + e.message });
    }
});
 
// 8. 완료 표시 토글 (Done)
app.post('/api/notion/complete', async (req, res) => {
    const { token, taskId } = req.body;
    const notion = new Client({ auth: token });
    try {
        // 현재 상태 조회
        const page = await notion.pages.retrieve({ page_id: taskId });
        const currentDone = page.properties.Done?.checkbox || false;
 
        // 토글
        await notion.pages.update({
            page_id: taskId,
            properties: {
                "Done": { checkbox: !currentDone }
            }
        });
        res.json({ success: true, done: !currentDone });
    } catch (e) {
        res.status(500).json({ error: "완료 표시 변경 실패: " + e.message });
    }
});
 
// 9. 일정 미루기 (다음날로)
app.post('/api/notion/postpone', async (req, res) => {
    const { token, taskId } = req.body;
    const notion = new Client({ auth: token });
    try {
        // 현재 날짜 조회
        const page = await notion.pages.retrieve({ page_id: taskId });
        const dateProp = page.properties.Date?.date;
        const currentStart = dateProp?.start;
        const currentEnd = dateProp?.end;
 
        if (!currentStart) {
            return res.status(400).json({ error: "날짜가 설정되지 않은 일정입니다." });
        }
 
        // 하루 뒤로 미루기
        const startDate = new Date(currentStart);
        startDate.setDate(startDate.getDate() + 1);
        const newStartDate = startDate.toISOString().split('T')[0];
 
        // 시간 정보가 있었으면 유지
        const newStart = currentStart.includes('T')
            ? newStartDate + 'T' + currentStart.split('T')[1]
            : newStartDate;
 
        const dateProperty = { start: newStart };
 
        // 종료 시간도 있으면 같이 미루기
        if (currentEnd) {
            const endDate = new Date(currentEnd);
            endDate.setDate(endDate.getDate() + 1);
            const newEndDate = endDate.toISOString().split('T')[0];
            const newEnd = currentEnd.includes('T')
                ? newEndDate + 'T' + currentEnd.split('T')[1]
                : newEndDate;
            dateProperty.end = newEnd;
        }
 
        await notion.pages.update({
            page_id: taskId,
            properties: {
                "Date": { date: dateProperty }
            }
        });
        res.json({ success: true, newDate: newStart });
    } catch (e) {
        res.status(500).json({ error: "일정 미루기 실패: " + e.message });
    }
});
 
// 10. 데이터베이스 속성 초기화 (필요한 속성 자동 추가)
app.post('/api/notion/init-database', async (req, res) => {
    const { token, dbId } = req.body;
    const notion = new Client({ auth: token });
    try {
        const database = await notion.databases.retrieve({ database_id: dbId });
        const existingProps = Object.keys(database.properties);
 
        const propsToAdd = {};
 
        // 필수 속성들 확인 및 추가
        if (!existingProps.includes('Date')) {
            propsToAdd['Date'] = { date: {} };
        }
        if (!existingProps.includes('Done')) {
            propsToAdd['Done'] = { checkbox: {} };
        }
        if (!existingProps.includes('Priority')) {
            propsToAdd['Priority'] = { checkbox: {} };
        }
        if (!existingProps.includes('Category')) {
            propsToAdd['Category'] = { multi_select: { options: [] } };
        }
        if (!existingProps.includes('Routine')) {
            propsToAdd['Routine'] = { checkbox: {} };
        }
        if (!existingProps.includes('RepeatDays')) {
            propsToAdd['RepeatDays'] = {
                multi_select: {
                    options: [
                        { name: '일', color: 'red' },
                        { name: '월', color: 'orange' },
                        { name: '화', color: 'yellow' },
                        { name: '수', color: 'green' },
                        { name: '목', color: 'blue' },
                        { name: '금', color: 'purple' },
                        { name: '토', color: 'pink' }
                    ]
                }
            };
        }
 
        if (Object.keys(propsToAdd).length > 0) {
            await notion.databases.update({
                database_id: dbId,
                properties: propsToAdd
            });
            res.json({ success: true, added: Object.keys(propsToAdd) });
        } else {
            res.json({ success: true, added: [], message: "모든 속성이 이미 존재합니다." });
        }
    } catch (e) {
        res.status(500).json({ error: "데이터베이스 초기화 실패: " + e.message });
    }
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Notion Calendar Server running on port ${PORT}`));
